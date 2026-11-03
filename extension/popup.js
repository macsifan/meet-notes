const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const autoRecord = document.getElementById('autoRecord');
const language = document.getElementById('language');

let recording = false;

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function render() {
  toggle.textContent = recording ? 'Остановить запись' : 'Начать запись';
  toggle.classList.toggle('recording', recording);
  toggle.disabled = false;
}

async function checkServer() {
  try {
    await fetch('http://127.0.0.1:8788/status');
    return true;
  } catch {
    setStatus('Сервер заметок не запущен: npm run server', true);
    return false;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showRecordingTime(startedAt) {
  const minutes = Math.floor((Date.now() - new Date(startedAt)) / 60000);
  setStatus(`Идёт запись · ${minutes} мин`);
}

async function start() {
  const tab = await activeTab();
  const response = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab?.id });

  if (!response?.ok) {
    setStatus(response?.error ?? 'Не удалось начать запись', true);
    render();
    return false;
  }

  recording = true;
  setStatus('Идёт запись');
  render();
  return true;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  recording = Boolean(state?.session);
  autoRecord.checked = state?.settings?.autoRecord ?? true;
  language.value = state?.settings?.language ?? 'ru';
  render();

  if (recording) {
    showRecordingTime(state.session.startedAt);
    return;
  }

  if (!(await checkServer())) return;

  // Открытие popup — это клик пользователя, а значит тот самый жест, которого
  // Chrome требует для захвата вкладки. Поэтому автозапуск делаем здесь.
  const tab = await activeTab();
  const onMeet = tab?.url?.startsWith('https://meet.google.com/');

  if (autoRecord.checked && onMeet && !state?.autoSuppressed) {
    setStatus('Запускаю запись…');
    await start();
    return;
  }

  setStatus(onMeet ? 'Готово к записи' : 'Откройте вкладку Google Meet');
}

toggle.addEventListener('click', async () => {
  toggle.disabled = true;

  if (recording) {
    setStatus('Останавливаю…');
    const response = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    if (!response?.ok) {
      setStatus(response?.error ?? 'Не удалось остановить', true);
    } else {
      recording = false;
      setStatus('Запись отправлена, заметка готовится');
    }
    render();
    return;
  }

  setStatus('Запускаю…');
  await start();
});

autoRecord.addEventListener('change', () =>
  chrome.storage.local.set({ autoRecord: autoRecord.checked }),
);

// Действует со следующей записи: язык идущей уже сохранён в её метаданных.
language.addEventListener('change', () => chrome.storage.local.set({ language: language.value }));

refresh();
