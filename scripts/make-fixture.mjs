#!/usr/bin/env node
/**
 * Собирает синтетическую запись встречи для сквозной проверки пайплайна:
 * аудио + meta.json с точным логом говорящих.
 *
 *   node scripts/make-fixture.mjs [папка]
 *
 * Голос в macOS для русского один (Milena), поэтому спикеры различаются
 * темпом речи. Для пайплайна это неважно: имена берутся из speakerEvents,
 * а не из голоса.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DIALOG = [
  { speaker: 'Иван', rate: 175, text: 'Всем привет. Сегодня надо решить два вопроса: сроки релиза и нагрузочное тестирование.' },
  { speaker: 'Мария', rate: 205, text: 'По срокам мы не успеваем к двадцатому августа, потому что стенд ещё не готов.' },
  { speaker: 'Иван', rate: 175, text: 'Тогда переносим релиз на двадцать пятое августа. Возражения есть?' },
  { speaker: 'Мария', rate: 205, text: 'Согласна. Я возьму на себя настройку нагрузочного стенда и сделаю её к пятнице.' },
  { speaker: 'Иван', rate: 175, text: 'Хорошо. Тогда я подготовлю план миграции базы данных до среды.' },
  { speaker: 'Мария', rate: 205, text: 'Остался открытый вопрос: кто дежурит в ночь релиза. Мы это не обсудили.' },
  { speaker: 'Иван', rate: 175, text: 'Вынесем на следующую встречу. И есть риск, что подрядчик не успеет прислать сертификаты вовремя.' },
];

async function durationSeconds(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

async function main() {
  const outDir = process.argv[2] ?? path.join(ROOT, 'test', 'fixtures');
  const partsDir = path.join(outDir, 'parts');
  await mkdir(partsDir, { recursive: true });

  const speakerEvents = [];
  const listLines = [];
  let cursor = 0;

  for (const [index, line] of DIALOG.entries()) {
    const partPath = path.join(partsDir, `${index}.aiff`);
    await run('say', ['-v', 'Milena', '-r', String(line.rate), '-o', partPath, line.text]);

    speakerEvents.push({ t: Number(cursor.toFixed(2)), name: line.speaker });
    cursor += await durationSeconds(partPath);
    listLines.push(`file '${partPath}'`);
  }

  const listPath = path.join(partsDir, 'list.txt');
  await writeFile(listPath, listLines.join('\n'), 'utf8');

  const audioPath = path.join(outDir, 'meeting.m4a');
  await run('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-y', audioPath]);

  const meta = {
    title: 'Синк по релизу',
    startedAt: '2026-08-11T14:30:00+03:00',
    timezone: 'Europe/Moscow',
    durationSec: Math.round(cursor),
    participants: ['Иван', 'Мария'],
    language: 'ru',
    speakerEvents,
  };
  const metaPath = path.join(outDir, 'meeting.meta.json');
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  await rm(partsDir, { recursive: true, force: true });
  console.log(`✓ фикстура готова: ${audioPath} (${meta.durationSec} с)\n  ${metaPath}`);
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
