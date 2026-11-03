#!/usr/bin/env node
/**
 * Пайплайн: запись встречи → готовая заметка.
 *
 *   node pipeline/run.mjs <аудио> <meta.json> [--out data/notes]
 *
 * meta.json описывает встречу и содержит speakerEvents — лог активного
 * говорящего, собранный расширением из DOM Meet.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transcribe } from './transcribe.mjs';
import { attributeSpeakers, SELF_FALLBACK } from './attribute.mjs';
import { adviseSpeaker, speakingStats } from './feedback.mjs';
import { summarize } from './summarize.mjs';
import { renderNote } from './render.mjs';
import { buildWhisperPrompt, loadGlossary } from './vocabulary.mjs';
import { cleanParticipants, parseParticipantName } from '../extension/participant-name.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODEL = path.join(ROOT, 'models', 'ggml-large-v3-turbo.bin');
const VAD_MODEL = path.join(ROOT, 'models', 'ggml-silero-v5.1.2.bin');
const DEFAULT_OUT = path.join(ROOT, 'data', 'notes');
const GLOSSARY = path.join(ROOT, 'data', 'glossary.txt');

/** Код встречи и заглушка — не название: подсказывать Whisper ими нечего. */
const PLACEHOLDER_TITLE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$|^Встреча в Google Meet$/;

/**
 * Всё, что пайплайн знает о встрече до распознавания: чистый список
 * участников, кто из них владелец записи и словарь для Whisper.
 * Списки из Meet до правки разбора имён содержат мусор вроде
 * «Oleg Sokolov(You)Meeting hostfront_handLower» — он чистится здесь.
 *
 * @param {object} meta
 * @param {{glossaryFile?: string}} options
 */
export async function prepareMeeting(meta, { glossaryFile = GLOSSARY } = {}) {
  const { participants, selfName: markedSelf } = cleanParticipants(meta.participants ?? []);
  const selfName = parseParticipantName(meta.selfName)?.name ?? markedSelf;
  const glossary = await loadGlossary(glossaryFile);
  const title = meta.title && !PLACEHOLDER_TITLE.test(meta.title) ? meta.title : undefined;

  return {
    participants,
    selfName,
    glossary,
    prompt: buildWhisperPrompt({ title, participants, glossary }),
    // Старые записи помечены 'auto': язык тогда не выбирался.
    language: meta.language ?? 'ru',
  };
}

/**
 * Имя файла заметки: дата и местное время начала впереди — папка сортируется
 * хронологически, а две встречи с одинаковым названием в один день
 * не затирают друг друга. Повторная обработка той же записи даёт то же имя.
 */
export function noteFilename(title, startedAt, timezone) {
  const when = new Date(startedAt);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, // undefined → системный пояс
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(when);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';

  const stamp = `${get('year')}-${get('month')}-${get('day')}-${get('hour')}${get('minute')}`;
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stamp}-${slug || 'встреча'}.md`;
}

/**
 * Разбор того, как владелец записи общался. Он необязателен: если модель
 * не ответила, заметка всё равно выходит, с одними цифрами.
 */
async function reviewSpeaker(utterances, selfLabel) {
  const stats = speakingStats(utterances, selfLabel);
  if (!stats) return null;
  try {
    return { stats, advice: await adviseSpeaker(utterances, selfLabel, stats) };
  } catch (error) {
    console.error(`разбор общения не удался: ${error.message}`);
    return { stats, advice: null };
  }
}

/**
 * @param {string} audioPath
 * @param {object} meta
 * @param {{outDir?: string, model?: string, onStage?: (stage: string) => void}} options
 */
export async function processRecording(audioPath, meta, options = {}) {
  const { outDir = DEFAULT_OUT, model = DEFAULT_MODEL, onStage = () => {} } = options;

  const meeting = await prepareMeeting(meta);
  const cleanMeta = { ...meta, participants: meeting.participants, selfName: meeting.selfName };

  onStage('транскрипция');
  const vadModel = await access(VAD_MODEL).then(() => VAD_MODEL, () => undefined);
  const segments = await transcribe(audioPath, {
    model,
    language: meeting.language,
    vadModel,
    prompt: meeting.prompt,
    channels: meta.channels,
  });

  onStage('сшивка со спикерами');
  const utterances = attributeSpeakers(segments, meta.speakerEvents ?? [], meeting.participants, {
    selfName: meeting.selfName,
  });

  onStage('выжимка');
  const summary = await summarize(utterances, { ...cleanMeta, glossary: meeting.glossary });

  onStage('разбор общения');
  const review = await reviewSpeaker(utterances, meeting.selfName ?? SELF_FALLBACK);

  onStage('рендер');
  const markdown = renderNote({ meta: cleanMeta, summary, utterances, review });

  await mkdir(outDir, { recursive: true });
  const notePath = path.join(
    outDir,
    noteFilename(meta.title || summary.title || 'встреча', meta.startedAt, meta.timezone),
  );
  await writeFile(notePath, markdown, 'utf8');

  return { notePath, utterances, summary };
}

async function main() {
  const [audioPath, metaPath, ...rest] = process.argv.slice(2);
  if (!audioPath || !metaPath) {
    console.error('Использование: node pipeline/run.mjs <аудио> <meta.json> [--out <папка>]');
    process.exit(1);
  }

  const outIndex = rest.indexOf('--out');
  const outDir = outIndex !== -1 ? rest[outIndex + 1] : undefined;
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));

  const started = Date.now();
  const { notePath } = await processRecording(audioPath, meta, {
    outDir,
    onStage: (stage) => console.log(`→ ${stage}...`),
  });

  console.log(`✓ заметка готова за ${Math.round((Date.now() - started) / 1000)} с: ${notePath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
