#!/usr/bin/env node
/**
 * Замер качества распознавания на своих записях.
 *
 * 1. Вырезать фрагмент встречи (3-5 минут) и получить черновик транскрипта:
 *      node scripts/eval.mjs cut <id записи> --from 600 --to 900 [--name планирование]
 *    В data/eval/<имя>/ появятся audio.flac, meta.json и draft.txt.
 * 2. Скопировать draft.txt в reference.txt и вычитать: исправить слова
 *    и подписи говорящих (формат «Имя: реплика», «?» — неизвестно).
 * 3. Прогнать замер:
 *      node scripts/eval.mjs run [--label база] [--no-prompt] [--no-channels]
 *                               [--language auto] [--model models/другая.bin]
 *    Флаги выключают отдельные улучшения: так видно, сколько даёт каждое.
 *    Итог печатается таблицей и сохраняется в data/eval/results/.
 *
 * Фрагменты нужны короткие: выравнивание квадратично по числу слов.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transcribe } from '../pipeline/transcribe.mjs';
import { attributeSpeakers } from '../pipeline/attribute.mjs';
import { prepareMeeting } from '../pipeline/run.mjs';
import { parseTranscript, scoreTranscript } from '../pipeline/metrics.mjs';
import { formatTimecode } from '../pipeline/render.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDINGS = path.join(ROOT, 'data', 'recordings');
const EVAL = path.join(ROOT, 'data', 'eval');
const DEFAULT_MODEL = path.join(ROOT, 'models', 'ggml-large-v3-turbo.bin');
const VAD_MODEL = path.join(ROOT, 'models', 'ggml-silero-v5.1.2.bin');

function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : fallback;
}

const flag = (args, name) => args.includes(`--${name}`);

/** Лог говорящих фрагмента: события внутри окна плюс тот, кто говорил на его старте. */
export function sliceSpeakerEvents(events, from, to) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const before = sorted.filter((e) => e.t <= from).at(-1);
  const inside = sorted
    .filter((e) => e.t > from && e.t < to)
    .map((e) => ({ ...e, t: Number((e.t - from).toFixed(2)) }));
  return before ? [{ t: 0, name: before.name }, ...inside] : inside;
}

async function transcribeCase(dir, meta, settings) {
  const meeting = await prepareMeeting({ ...meta, language: settings.language ?? meta.language });
  const vadModel = await access(VAD_MODEL).then(() => VAD_MODEL, () => undefined);

  const segments = await transcribe(path.join(dir, 'audio.flac'), {
    model: settings.model,
    language: meeting.language,
    vadModel,
    prompt: settings.prompt ? meeting.prompt : '',
    channels: settings.channels ? meta.channels : undefined,
  });
  const utterances = attributeSpeakers(segments, meta.speakerEvents ?? [], meeting.participants, {
    selfName: meeting.selfName,
  });
  return { meeting, utterances };
}

function formatUtterances(utterances) {
  return utterances.map((u) => `${u.speaker ?? '?'}: ${u.text}`).join('\n');
}

async function cut(args) {
  const [id] = args;
  const from = Number(option(args, 'from', 0));
  const to = Number(option(args, 'to', from + 300));
  if (!id || !(to > from)) throw new Error('Использование: cut <id записи> --from <сек> --to <сек> [--name имя]');

  const source = path.join(RECORDINGS, id);
  const meta = JSON.parse(await readFile(path.join(source, 'meta.json'), 'utf8'));
  const name = option(args, 'name', `${id.slice(0, 8)}-${from}`);
  const dir = path.join(EVAL, name);
  await mkdir(dir, { recursive: true });

  // FLAC без потерь и с исходными каналами: стерео нужно для разметки по каналам.
  await run('ffmpeg', [
    '-v', 'error', '-ss', String(from), '-to', String(to),
    '-i', path.join(source, 'audio.webm'), '-ar', '16000', '-c:a', 'flac', '-y', path.join(dir, 'audio.flac'),
  ]);

  const caseMeta = {
    source: id,
    from,
    to,
    title: meta.title,
    participants: meta.participants ?? [],
    selfName: meta.selfName ?? null,
    // В старых записях язык не выбирался и стоит 'auto'.
    language: meta.language && meta.language !== 'auto' ? meta.language : 'ru',
    channels: meta.channels,
    speakerEvents: sliceSpeakerEvents(meta.speakerEvents ?? [], from, to),
  };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(caseMeta, null, 2), 'utf8');

  console.log(`→ черновик транскрипта ${formatTimecode(from)}–${formatTimecode(to)}...`);
  const { utterances } = await transcribeCase(dir, caseMeta, {
    model: DEFAULT_MODEL,
    prompt: true,
    channels: true,
  });
  const header = [
    '# Черновик из текущего пайплайна. Скопируйте в reference.txt и исправьте:',
    '# слова должны быть ровно такими, как сказано, подписи — реальными говорящими.',
    '# Формат: «Имя: реплика». «?» — говорящий неизвестен. Строки с # не считаются.',
  ].join('\n');
  await writeFile(path.join(dir, 'draft.txt'), `${header}\n\n${formatUtterances(utterances)}\n`, 'utf8');
  console.log(`✓ ${path.relative(ROOT, dir)}/draft.txt`);
}

const percent = (value) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

async function evaluate(args) {
  const settings = {
    model: path.resolve(ROOT, option(args, 'model', DEFAULT_MODEL)),
    prompt: !flag(args, 'no-prompt'),
    channels: !flag(args, 'no-channels'),
    language: option(args, 'language', undefined),
  };
  const label = option(args, 'label', path.basename(settings.model, '.bin'));
  const only = option(args, 'case', undefined);

  const entries = await readdir(EVAL, { withFileTypes: true }).catch(() => []);
  const cases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'results' || (only && entry.name !== only)) continue;
    const dir = path.join(EVAL, entry.name);
    const reference = await readFile(path.join(dir, 'reference.txt'), 'utf8').catch(() => null);
    if (reference) cases.push({ name: entry.name, dir, reference });
  }
  if (!cases.length) {
    throw new Error('Нет фрагментов с reference.txt в data/eval/. Сначала: node scripts/eval.mjs cut ...');
  }

  const results = [];
  for (const testCase of cases) {
    const meta = JSON.parse(await readFile(path.join(testCase.dir, 'meta.json'), 'utf8'));
    const started = Date.now();
    const { meeting, utterances } = await transcribeCase(testCase.dir, meta, settings);
    const seconds = (Date.now() - started) / 1000;

    const hypothesisText = formatUtterances(utterances);
    await writeFile(path.join(testCase.dir, `hypothesis-${label}.txt`), `${hypothesisText}\n`, 'utf8');

    const score = scoreTranscript(
      parseTranscript(testCase.reference),
      parseTranscript(hypothesisText),
      [...meeting.glossary, ...meeting.participants],
    );
    results.push({ case: testCase.name, seconds, ...score });
  }

  console.log(`\nНастройки: ${label} · подсказка ${settings.prompt ? 'да' : 'нет'} · каналы ${settings.channels ? 'да' : 'нет'}`);
  console.table(
    results.map((r) => ({
      фрагмент: r.case,
      слов: r.words,
      WER: percent(r.wer),
      'термины и имена': `${percent(r.vocabulary.recall)} (${r.vocabulary.found}/${r.vocabulary.expected})`,
      'подписи верны': percent(r.speakers.accuracy),
      'без подписи': percent(r.speakers.unlabelledShare),
      секунд: r.seconds.toFixed(0),
    })),
  );
  for (const r of results) {
    if (r.vocabulary.missed.length) console.log(`  ${r.case}: не распознаны ${r.vocabulary.missed.join(', ')}`);
  }

  const totalWords = results.reduce((sum, r) => sum + r.words, 0);
  const pooledWer = results.reduce((sum, r) => sum + r.wer * r.words, 0) / totalWords;
  console.log(`\nWER по всем фрагментам: ${percent(pooledWer)}`);

  await mkdir(path.join(EVAL, 'results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(EVAL, 'results', `${stamp}-${label}.json`);
  await writeFile(reportPath, JSON.stringify({ label, settings, pooledWer, results }, null, 2), 'utf8');
  console.log(`✓ ${path.relative(ROOT, reportPath)}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'cut') return cut(args);
  if (command === 'run') return evaluate(args);
  console.error('Использование: node scripts/eval.mjs cut|run ... (подробности в начале файла)');
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
