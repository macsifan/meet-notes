/**
 * Транскрипция аудио локальным whisper.cpp.
 *
 * Whisper просится выдавать по слову (-ml 1 -sow): только у таких сегментов
 * время пересчитывается обратно на шкалу записи после вырезания тишины VAD,
 * у токенов внутри длинного сегмента оно остаётся сдвинутым. Слова потом
 * собираются обратно во фразы, и у каждой фразы остаётся список слов с
 * таймкодами: по ним attribute.mjs режет фразу на смене говорящего.
 *
 * Наружу отдаёт сегменты в секундах — формат, который ждёт attribute.mjs.
 */

import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

import { channelEnergy, dominantChannel } from './channels.mjs';

const run = promisify(execFile);

/** Whisper помечает тишину и шумы служебными вставками — в транскрипте они мусор. */
const NOISE = /^\[[A-Z_ ]+\]$|^\(.*\)$/;

/**
 * На тихих участках Whisper галлюцинирует фразами из субтитров телепередач —
 * артефакт обучающих данных. Реальной речью такие строки не бывают.
 *
 * Шаблон описывает фразу целиком: при пословном выводе галлюцинация без
 * точки на конце склеивается с настоящей речью, и выбросить надо только её.
 */
const HALLUCINATIONS = [
  /редактор субтитров(\s+[А-ЯЁA-Z]\.\s*\S+)?/gi,
  /корректор\s+[А-ЯЁA-Z]\.\s*\S+/gi,
  /субтитры\s+(сделал|делал|создавал|подготовил)\S*\s+\S+/gi,
  /\S*dimatorzok\S*/gi,
  /продолжение следует[.…!]*/gi,
  /спасибо за просмотр[.…!]*/gi,
];

/**
 * Убирает из сегмента слова, попавшие в галлюцинацию.
 * @returns {object|null} null — от сегмента ничего не осталось
 */
function stripHallucinations(segment) {
  // Где в тексте сегмента начинается и кончается каждое слово.
  const spans = [];
  let cursor = 0;
  for (const word of segment.words) {
    spans.push([cursor, cursor + word.text.length]);
    cursor += word.text.length + 1;
  }

  const doomed = new Set();
  for (const pattern of HALLUCINATIONS) {
    for (const match of segment.text.matchAll(pattern)) {
      const from = match.index;
      const to = from + match[0].length;
      spans.forEach(([start, end], i) => {
        if (start < to && from < end) doomed.add(i);
      });
    }
  }

  if (!doomed.size) return segment;
  const words = segment.words.filter((_, i) => !doomed.has(i));
  if (!words.length) return null;
  return {
    start: words[0].start,
    end: words.at(-1).end,
    text: words.map((w) => w.text).join(' '),
    words,
  };
}

/**
 * Один и тот же текст более трёх раз подряд — модель зациклилась, а не человек
 * повторяется. Оставляем первое вхождение, остальные выбрасываем.
 */
const MAX_CONSECUTIVE_REPEATS = 3;

function dropLoops(segments) {
  const result = [];
  let i = 0;

  while (i < segments.length) {
    let runEnd = i;
    while (runEnd + 1 < segments.length && segments[runEnd + 1].text === segments[i].text) {
      runEnd += 1;
    }

    const runLength = runEnd - i + 1;
    if (runLength > MAX_CONSECUTIVE_REPEATS) {
      result.push(segments[i]); // зацикливание: оставляем первое вхождение
    } else {
      result.push(...segments.slice(i, runEnd + 1)); // обычная речь с повторами
    }
    i = runEnd + 1;
  }
  return result;
}

/** Конец фразы: после такого слова начинается новый сегмент. */
const SENTENCE_END = /[.!?…]["»)]?$/;

/** Фраза без точек (Whisper иногда их не ставит) всё равно режется. */
const MAX_SEGMENT_WORDS = 40;

/** Пауза длиннее этой тоже разрывает фразу. */
const MAX_WORD_GAP_SEC = 2;

/** Вставка в скобках длиннее этого — уже не пометка Whisper, а настоящая речь. */
const MAX_BRACKETED_WORDS = 5;

/**
 * Вставки в скобках вроде «(играет музыка)» Whisper пишет вместо речи,
 * и при пословном выводе они размазаны по нескольким словам.
 */
function dropBracketed(words) {
  const result = [];
  let i = 0;

  while (i < words.length) {
    if (/^[([]/.test(words[i].text)) {
      const window = words.slice(i, i + MAX_BRACKETED_WORDS);
      const close = window.findIndex((word) => /[)\]][.,!?…]*$/.test(word.text));
      if (close !== -1) {
        i += close + 1;
        continue;
      }
    }
    result.push(words[i]);
    i += 1;
  }
  return result;
}

function groupWords(words) {
  const segments = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    segments.push({
      start: current[0].start,
      end: current.at(-1).end,
      text: current.map((w) => w.text).join(' '),
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    const previous = current.at(-1);
    if (previous && word.start - previous.end > MAX_WORD_GAP_SEC) flush();
    current.push(word);
    if (SENTENCE_END.test(word.text) || current.length >= MAX_SEGMENT_WORDS) flush();
  }
  flush();
  return segments;
}

/** Сравнение без регистра и пунктуации: «Участники: Иван» ≈ «участники иван». */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * На тишине Whisper может зачитать саму подсказку. Совпадение одного имени
 * ещё ни о чём не говорит, поэтому выбрасываются только длинные куски.
 */
function echoesPrompt(text, normalizedPrompt) {
  const normalized = normalize(text);
  return (
    normalizedPrompt.length > 0 &&
    normalized.split(' ').length >= 4 &&
    normalized.length >= 20 &&
    normalizedPrompt.includes(normalized)
  );
}

/**
 * @param {{transcription: {offsets: {from: number, to: number}, text: string}[]}} whisperOutput
 *   при пословном выводе каждый элемент — слово, иначе — фраза целиком
 * @param {{prompt?: string}} options подсказка, которую видел Whisper
 * @returns {{start: number, end: number, text: string, words: {start: number, end: number, text: string}[]}[]} секунды
 */
export function parseWhisperJson(whisperOutput, { prompt = '' } = {}) {
  const words = (whisperOutput.transcription ?? [])
    .map((item) => ({
      start: item.offsets.from / 1000,
      end: item.offsets.to / 1000,
      text: item.text.trim(),
    }))
    .filter((word) => word.text && !NOISE.test(word.text));

  const normalizedPrompt = normalize(prompt);
  const segments = groupWords(dropBracketed(words))
    .map(stripHallucinations)
    .filter(
      (segment) =>
        segment && !NOISE.test(segment.text) && !echoesPrompt(segment.text, normalizedPrompt),
    );

  return dropLoops(segments);
}

async function countChannels(inputPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=channels',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 1;
}

/**
 * whisper.cpp принимает только 16 кГц моно WAV, поэтому запись всегда
 * перекодируется. Для стерео-записи рядом кладётся сырой PCM обоих каналов:
 * по нему определяется, чей голос звучит в каждом слове.
 */
async function decode(inputPath, wavPath, rawPath) {
  await run('ffmpeg', [
    '-v', 'error',
    '-i', inputPath,
    '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath,
    ...(rawPath ? ['-map', '0:a:0', '-ar', '16000', '-ac', '2', '-f', 's16le', '-y', rawPath] : []),
  ]);
}

/**
 * Помечает слова каналом, в котором они прозвучали.
 * @param {object[]} segments
 * @param {object} energy
 * @param {{left?: string, right?: string}} channels что записано в каждом канале
 */
function labelChannels(segments, energy, channels) {
  for (const segment of segments) {
    for (const word of segment.words) {
      const side = dominantChannel(energy, word.start, word.end);
      word.channel = side ? (channels[side] ?? null) : null;
    }
  }
  return segments;
}

/**
 * @param {string} audioPath запись встречи (webm/m4a/wav)
 * @param {{
 *   model: string,
 *   language?: string,
 *   threads?: number,
 *   vadModel?: string,
 *   prompt?: string,
 *   channels?: {left?: string, right?: string},
 * }} options channels — разметка стерео-записи, например {left: 'mic', right: 'tab'}
 * @returns {Promise<{start: number, end: number, text: string, words: object[]}[]>}
 */
export async function transcribe(
  audioPath,
  { model, language = 'ru', threads, vadModel, prompt = '', channels } = {},
) {
  const workdir = path.join(os.tmpdir(), `meet-notes-${process.pid}-${Date.now()}`);
  const wavPath = `${workdir}.wav`;
  const rawPath = `${workdir}.stereo.raw`;
  const outPrefix = workdir;

  const stereo = Boolean(channels) && (await countChannels(audioPath)) === 2;

  try {
    await decode(audioPath, wavPath, stereo ? rawPath : null);
    await run('whisper-cli', [
      '-m', model,
      '-f', wavPath,
      '-l', language,
      '-t', String(threads ?? Math.max(4, os.availableParallelism() - 2)),
      '-oj',
      '-of', outPrefix,
      '-np',
      // По слову на сегмент: см. комментарий в начале файла.
      '-ml', '1', '-sow',
      // Не даёт модели писать «[музыка]» и прочие неречевые вставки.
      '-sns',
      // VAD вырезает тишину до распознавания: на паузах Whisper галлюцинирует
      // и может зациклиться, потеряв остаток встречи.
      ...(vadModel ? ['--vad', '--vad-model', vadModel] : []),
      // Подсказка повторяется в каждом окне, иначе через минуту её вытесняет
      // уже распознанный текст и имена снова начинают коверкаться.
      ...(prompt ? ['--prompt', prompt, '--carry-initial-prompt'] : []),
    ], { maxBuffer: 64 * 1024 * 1024 });

    const segments = parseWhisperJson(JSON.parse(await readFile(`${outPrefix}.json`, 'utf8')), { prompt });
    if (!stereo) return segments;
    return labelChannels(segments, await channelEnergy(rawPath), channels);
  } finally {
    await rm(wavPath, { force: true });
    await rm(rawPath, { force: true });
    await rm(`${outPrefix}.json`, { force: true });
  }
}
