/**
 * Оркестратор записи.
 *
 * Service worker в MV3 может быть выгружен в любой момент, поэтому состояние
 * сессии живёт в chrome.storage.session, а не в переменных модуля.
 */

const SERVER = 'http://127.0.0.1:8788';
const OFFSCREEN_PATH = 'offscreen.html';

async function getSession() {
  const { session } = await chrome.storage.session.get('session');
  return session ?? null;
}

async function setSession(session) {
  await chrome.storage.session.set({ session });
  await chrome.action.setBadgeText({ text: session ? 'REC' : '' });
  if (session) await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

/**
 * Язык встречи задаётся явно: автоопределение Whisper смотрит только на первые
 * 30 секунд и на «hello, can you hear me» в начале уводит всю встречу не туда.
 */
async function getSettings() {
  const { autoRecord = true, language = 'ru' } = await chrome.storage.local.get([
    'autoRecord',
    'language',
  ]);
  return { autoRecord, language };
}

/**
 * После ручной остановки автозапуск молчит до следующего входа во встречу —
 * иначе открытие popup тут же начало бы новую запись.
 */
async function setAutoSuppressed(value) {
  await chrome.storage.session.set({ autoSuppressed: value });
}

async function isAutoSuppressed() {
  const { autoSuppressed } = await chrome.storage.session.get('autoSuppressed');
  return Boolean(autoSuppressed);
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Сведение звука вкладки и микрофона для записи встречи',
  });
}

async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) await chrome.offscreen.closeDocument();
}

/** Content script знает про встречу то, чего не знает расширение: название и участников. */
async function askContentScript(tabId, type) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    return null; // вкладка не Meet или скрипт ещё не поднялся — не повод ронять запись
  }
}

async function postJson(pathname, data) {
  const response = await fetch(`${SERVER}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
  return response.json();
}

async function resolveMeetTab(tabId) {
  if (tabId) return chrome.tabs.get(tabId);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function startRecording({ tabId } = {}) {
  if (await getSession()) throw new Error('запись уже идёт');

  const tab = await resolveMeetTab(tabId);
  if (!tab?.url?.startsWith('https://meet.google.com/')) {
    throw new Error('откройте вкладку Google Meet');
  }

  // Требует user activation, поэтому вызывается либо сразу после клика в popup,
  // либо в попытке автозапуска, которая может быть отклонена Chrome.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const info = (await askContentScript(tab.id, 'MEETING_INFO')) ?? {};
  const { language } = await getSettings();
  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  await postJson(`/ingest/${sessionId}/meta`, {
    title: info.title || 'Встреча в Google Meet',
    startedAt,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    participants: info.participants ?? [],
    selfName: info.selfName ?? null,
    language,
    // Микрофон пишется в левый канал, собеседники в правый: по каналу
    // пайплайн узнаёт реплики владельца записи без лога Meet.
    channels: { left: 'mic', right: 'tab' },
    // Все найденные варианты названия сохраняются для разбора,
    // если выбранный окажется не тем.
    titleCandidates: info.titleCandidates ?? null,
  });

  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    sessionId,
    server: SERVER,
  });

  await askContentScript(tab.id, 'RECORDING_STARTED');
  await setSession({ sessionId, tabId: tab.id, startedAt });
  return { sessionId };
}

async function stopRecording() {
  const session = await getSession();
  if (!session) throw new Error('запись не идёт');

  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' });
  await closeOffscreen();

  const log = (await askContentScript(session.tabId, 'SPEAKER_LOG')) ?? {};
  await askContentScript(session.tabId, 'RECORDING_STOPPED');

  await postJson(`/ingest/${session.sessionId}/finish`, {
    durationSec: Math.round((Date.now() - new Date(session.startedAt)) / 1000),
    speakerEvents: log.speakerEvents ?? [],
    participants: log.participants ?? [],
    ...(log.selfName ? { selfName: log.selfName } : {}),
    ...(log.title ? { title: log.title } : {}),
    ...(log.titleCandidates ? { titleCandidates: log.titleCandidates } : {}),
  });

  await setSession(null);
  return { sessionId: session.sessionId };
}

/**
 * Chrome разрешает захват вкладки только после жеста пользователя, поэтому
 * автозапуск — попытка: если она отклонена, на иконке загорается подсказка,
 * и запись стартует одним кликом по ней.
 */
async function tryAutoStart(tabId) {
  const { autoRecord } = await getSettings();
  if (!autoRecord || (await getSession()) || (await isAutoSuppressed())) return;

  try {
    await startRecording({ tabId });
  } catch (error) {
    console.warn('[meet-notes] автозапуск отклонён:', error.message);
    await chrome.action.setBadgeText({ text: '▶' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  }
}

async function handleLeftMeeting(tabId) {
  const session = await getSession();
  await chrome.action.setBadgeText({ text: '' });
  if (session?.tabId === tabId) await stopRecording().catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return; // не наше сообщение

  const handlers = {
    START_RECORDING: async () => {
      await setAutoSuppressed(false);
      return startRecording({ tabId: message.tabId });
    },
    STOP_RECORDING: async () => {
      await setAutoSuppressed(true);
      return stopRecording();
    },
    GET_STATE: async () => ({
      session: await getSession(),
      settings: await getSettings(),
      autoSuppressed: await isAutoSuppressed(),
    }),
    JOINED_MEETING: async () => {
      await setAutoSuppressed(false);
      await tryAutoStart(sender.tab?.id);
      return { ok: true };
    },
    LEFT_MEETING: async () => {
      await handleLeftMeeting(sender.tab?.id);
      return { ok: true };
    },
  };

  const handler = handlers[message.type];
  if (!handler) return;

  handler()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true; // ответ придёт асинхронно
});

/** Если вкладку встречи закрыли, не оставляем висящую запись. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (session?.tabId === tabId) await stopRecording().catch(() => {});
});
