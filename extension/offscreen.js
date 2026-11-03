/**
 * Захват и сведение звука. Работает в offscreen-документе, потому что
 * service worker в MV3 не имеет доступа к DOM и Web Audio.
 *
 * Микрофон пишется в левый канал, собеседники в правый, и стерео-поток уходит
 * на локальный сервер кусками по 5 секунд. Раздельные каналы позволяют
 * пайплайну узнавать реплики владельца записи по звуку, а не по плитке Meet.
 */

import { pickMicrophone } from './mic-select.js';

const CHUNK_MS = 5000;
const MAX_RETRIES = 5;

let recorder = null;
let audioContext = null;
let sourceStreams = [];
let uploadChain = Promise.resolve();
let failedChunks = 0;

async function sendChunk(server, sessionId, blob) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${server}/ingest/${sessionId}/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      if (response.ok) return true;
    } catch {
      // сервер мог быть перезапущен — ждём и пробуем снова
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  return false;
}

/**
 * Звук вкладки при захвате перестаёт звучать для пользователя,
 * поэтому исходный поток отдельно подключается к колонкам.
 */
async function startCapture({ streamId, sessionId, server }) {
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });

  let micStream = null;
  try {
    // Устройство по умолчанию может оказаться iPhone (Continuity) —
    // выбираем встроенный микрофон Mac явно.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const deviceId = pickMicrophone(devices);
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };

    micStream = await navigator.mediaDevices.getUserMedia({ audio }).catch((error) => {
      // Выбранное устройство могло отвалиться (наушники сняли) — берём системное.
      console.warn('[meet-notes] выбранный микрофон недоступен, беру системный:', error.message);
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    });
  } catch (error) {
    console.warn('[meet-notes] микрофон недоступен, пишем только собеседников:', error.message);
  }

  audioContext = new AudioContext();
  const mixed = audioContext.createMediaStreamDestination();
  mixed.channelCount = 2;

  // Входы ChannelMerger моно: стерео вкладки сводится в один канал сам.
  const merger = audioContext.createChannelMerger(2);
  merger.connect(mixed);

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(merger, 0, 1);
  tabSource.connect(audioContext.destination);

  if (micStream) audioContext.createMediaStreamSource(micStream).connect(merger, 0, 0);

  sourceStreams = [tabStream, micStream].filter(Boolean);

  recorder = new MediaRecorder(mixed.stream, {
    mimeType: 'audio/webm;codecs=opus',
    // На низком битрейте Opus экономит на стерео (intensity stereo), и каналы
    // частично смешиваются. Запас: по 64 кбит/с на канал.
    audioBitsPerSecond: 128000,
  });

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    // Чанки отправляются строго по очереди: на сервере они дописываются в один файл.
    uploadChain = uploadChain.then(async () => {
      const delivered = await sendChunk(server, sessionId, event.data);
      if (!delivered) failedChunks += 1;
    });
  };

  recorder.start(CHUNK_MS);
}

async function stopCapture() {
  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
  }
  await uploadChain;

  for (const stream of sourceStreams) stream.getTracks().forEach((track) => track.stop());
  if (audioContext) await audioContext.close();

  recorder = null;
  audioContext = null;
  sourceStreams = [];

  if (failedChunks) console.error(`[meet-notes] не доставлено фрагментов: ${failedChunks}`);
  const result = { failedChunks };
  failedChunks = 0;
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  const handlers = {
    START_CAPTURE: () => startCapture(message),
    STOP_CAPTURE: () => stopCapture(),
  };

  const handler = handlers[message.type];
  if (!handler) return;

  handler()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error('[meet-notes]', error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});
