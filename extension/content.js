/**
 * Часть расширения, живущая внутри вкладки встречи: собирает метаданные,
 * ведёт лог говорящих и сообщает о входе во встречу и выходе из неё.
 *
 * Индикатор записи внутри Meet намеренно не рисуется: он попал бы в кадр
 * при демонстрации экрана. Состояние видно по бейджу на иконке расширения.
 */

const MEETING_URL = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/;
const JOIN_BUTTON = /присоедин|join now|войти|попросить|ask to join/i;
const STATE_POLL_MS = 1500;

let tracker = null;
let inMeeting = false;

/** Модули подгружаются динамически: content script не может быть ES-модулем напрямую. */
async function loadDetector() {
  return import(chrome.runtime.getURL('speaker-detect.js'));
}

async function loadMeetingInfo() {
  return import(chrome.runtime.getURL('meeting-info.js'));
}

async function meetingTitle() {
  const { collectTitleCandidates, pickTitle } = await loadMeetingInfo();
  const candidates = collectTitleCandidates(document, location);
  return { title: pickTitle(candidates), titleCandidates: candidates };
}

/**
 * В лобби Meet показывает кнопку присоединения; когда она исчезла,
 * а в адресе код встречи — значит мы уже внутри звонка.
 */
function detectInMeeting() {
  if (!MEETING_URL.test(location.pathname)) return false;

  const joinButton = [...document.querySelectorAll('button, [role="button"]')].find(
    (element) =>
      element.offsetParent !== null &&
      JOIN_BUTTON.test(`${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`),
  );
  return !joinButton;
}

function watchMeetingState() {
  setInterval(() => {
    const now = detectInMeeting();
    if (now === inMeeting) return;

    inMeeting = now;
    chrome.runtime
      .sendMessage({ type: now ? 'JOINED_MEETING' : 'LEFT_MEETING' })
      .catch(() => {}); // service worker мог быть выгружен — не критично
  }, STATE_POLL_MS);
}

const handlers = {
  async MEETING_INFO() {
    const { createTracker } = await loadDetector();
    const probe = createTracker();
    probe.start();
    probe.stop();
    const { participants, selfName } = probe.getLog();
    return { ...(await meetingTitle()), participants, selfName };
  },

  async RECORDING_STARTED() {
    const { createTracker } = await loadDetector();
    tracker = createTracker();
    tracker.start();
    return { ok: true };
  },

  async RECORDING_STOPPED() {
    tracker?.stop();
    return { ok: true };
  },

  async SPEAKER_LOG() {
    const log = tracker?.getLog() ?? { speakerEvents: [], participants: [] };
    // Название пересобирается на выходе: к концу встречи Meet успевает
    // подставить его из календаря, даже если в момент старта его ещё не было.
    return { ...log, ...(await meetingTitle()) };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message.type];
  if (!handler) return;

  handler()
    .then(sendResponse)
    .catch((error) => {
      console.error('[meet-notes]', error);
      sendResponse(null);
    });
  return true;
});

watchMeetingState();
