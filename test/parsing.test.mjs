import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWhisperJson } from '../pipeline/transcribe.mjs';
import { extractJson, chunkUtterances, sanitizeSummary } from '../pipeline/summarize.mjs';

test('сегменты Whisper переводятся из миллисекунд в секунды', () => {
  const whisperOutput = {
    transcription: [
      { offsets: { from: 0, to: 3120 }, text: ' Всем привет.' },
      { offsets: { from: 3120, to: 7000 }, text: ' Начнём со статуса.' },
    ],
  };

  const segments = parseWhisperJson(whisperOutput);

  assert.deepEqual(
    segments.map(({ start, end, text }) => ({ start, end, text })),
    [
      { start: 0, end: 3.12, text: 'Всем привет.' },
      { start: 3.12, end: 7, text: 'Начнём со статуса.' },
    ],
  );
});

test('пустые и служебные сегменты Whisper отбрасываются', () => {
  const whisperOutput = {
    transcription: [
      { offsets: { from: 0, to: 1000 }, text: '  ' },
      { offsets: { from: 1000, to: 2000 }, text: ' [BLANK_AUDIO]' },
      { offsets: { from: 2000, to: 3000 }, text: ' Реальная реплика.' },
    ],
  };

  const segments = parseWhisperJson(whisperOutput);

  assert.deepEqual(
    segments.map((s) => s.text),
    ['Реальная реплика.'],
  );
});

test('галлюцинации Whisper на тишине отбрасываются', () => {
  // На тихих участках Whisper выдаёт фразы из субтитров телепередач —
  // это артефакт обучающих данных, а не речь.
  const whisperOutput = {
    transcription: [
      { offsets: { from: 0, to: 3000 }, text: ' Настоящая реплика.' },
      { offsets: { from: 3000, to: 30000 }, text: ' Редактор субтитров А.Семкин Корректор А.Егорова' },
      { offsets: { from: 30000, to: 33000 }, text: ' Продолжение следует...' },
      { offsets: { from: 33000, to: 36000 }, text: ' Субтитры сделал DimaTorzok' },
      { offsets: { from: 36000, to: 39000 }, text: ' Ещё одна настоящая.' },
    ],
  };

  const segments = parseWhisperJson(whisperOutput);

  assert.deepEqual(
    segments.map((s) => s.text),
    ['Настоящая реплика.', 'Ещё одна настоящая.'],
  );
});

test('зацикленный повтор одного и того же текста схлопывается до первого вхождения', () => {
  const repeated = { offsets: { from: 0, to: 1000 }, text: ' Угу.' };
  const whisperOutput = {
    transcription: [
      { offsets: { from: 0, to: 3000 }, text: ' Начало.' },
      ...Array.from({ length: 6 }, (_, i) => ({
        offsets: { from: 3000 + i * 1000, to: 4000 + i * 1000 },
        text: ' Так, посмотрим.',
      })),
      { offsets: { from: 9000, to: 12000 }, text: ' Конец.' },
    ],
  };

  const segments = parseWhisperJson(whisperOutput);

  assert.deepEqual(
    segments.map((s) => s.text),
    ['Начало.', 'Так, посмотрим.', 'Конец.'],
  );
});

test('обычные повторы-поддакивания не схлопываются', () => {
  // Два-три «угу» подряд — нормальная речь, зацикливание начинается дальше.
  const whisperOutput = {
    transcription: [
      { offsets: { from: 0, to: 1000 }, text: ' Угу.' },
      { offsets: { from: 1000, to: 2000 }, text: ' Угу.' },
      { offsets: { from: 2000, to: 5000 }, text: ' Понятно.' },
    ],
  };

  const segments = parseWhisperJson(whisperOutput);

  assert.equal(segments.length, 3);
});

test('JSON выжимки достаётся из ответа, обёрнутого в markdown-блок', () => {
  const answer = 'Вот результат:\n```json\n{"summary": "Обсудили сроки"}\n```\nГотово.';

  assert.deepEqual(extractJson(answer), { summary: 'Обсудили сроки' });
});

test('JSON выжимки читается и без обёртки', () => {
  assert.deepEqual(extractJson('{"summary": "Коротко"}'), { summary: 'Коротко' });
});

test('нечитаемый ответ модели вызывает понятную ошибку', () => {
  assert.throws(() => extractJson('Извините, не могу помочь.'), /не удалось разобрать JSON/i);
});

test('короткая встреча не режется на части', () => {
  const utterances = [{ speaker: 'Иван', start: 0, end: 5, text: 'Привет.' }];

  assert.equal(chunkUtterances(utterances, 1000).length, 1);
});

test('длинная встреча режется по границам реплик', () => {
  const utterances = Array.from({ length: 10 }, (_, i) => ({
    speaker: 'Иван',
    start: i * 10,
    end: i * 10 + 9,
    text: 'а'.repeat(100),
  }));

  const chunks = chunkUtterances(utterances, 300);

  assert.ok(chunks.length > 1, 'ожидалось несколько частей');
  assert.equal(
    chunks.flat().length,
    utterances.length,
    'реплики не должны теряться при нарезке',
  );
});

test('длинные тире из текста модели заменяются на обычные', () => {
  const summary = sanitizeSummary({
    title: 'Синк — планёрка',
    summary: 'Обсудили сроки — договорились перенести.',
    decisions: [{ what: 'Перенос — на неделю', context: 'Не успеваем — стенд не готов' }],
    action_items: [{ assignee: 'Иван', task: 'Собрать стенд — до среды', due: '', quote: 'соберу — обещаю' }],
    open_questions: ['Кто дежурит — не решили'],
    risks: [],
  });

  const flat = JSON.stringify(summary);
  assert.doesNotMatch(flat, /[—–]/);
  assert.match(summary.summary, /Обсудили сроки - договорились/);
});

/** Пословный вывод whisper-cli -ml 1 -sow: по элементу на слово, с ведущим пробелом. */
function wordOutput(words) {
  return {
    transcription: words.map(([text, from, to]) => ({ offsets: { from, to }, text: ` ${text}` })),
  };
}

test('слова собираются во фразы по точкам и сохраняют свои таймкоды', () => {
  const segments = parseWhisperJson(
    wordOutput([
      ['Привет', 0, 400],
      ['всем.', 400, 900],
      ['Начнём', 1000, 1400],
      ['со', 1400, 1500],
      ['статуса.', 1500, 2100],
    ]),
  );

  assert.deepEqual(
    segments.map((s) => s.text),
    ['Привет всем.', 'Начнём со статуса.'],
  );
  assert.deepEqual(segments[1].words[0], { start: 1, end: 1.4, text: 'Начнём' });
});

test('галлюцинация без точки вырезается, а склеенная с ней настоящая речь остаётся', () => {
  const segments = parseWhisperJson(
    wordOutput([
      ['Субтитры', 0, 400],
      ['сделал', 400, 800],
      ['DimaTorzok', 800, 1500],
      ['Давайте', 1600, 2000],
      ['начнём.', 2000, 2500],
    ]),
  );

  assert.deepEqual(
    segments.map((s) => s.text),
    ['Давайте начнём.'],
  );
  assert.equal(segments[0].start, 1.6);
});

test('пометки в скобках, размазанные по словам, выбрасываются', () => {
  const segments = parseWhisperJson(
    wordOutput([
      ['(играет', 0, 400],
      ['музыка)', 400, 900],
      ['Всем', 1000, 1400],
      ['привет.', 1400, 1900],
    ]),
  );

  assert.deepEqual(
    segments.map((s) => s.text),
    ['Всем привет.'],
  );
});

test('незакрытая скобка не съедает остаток встречи', () => {
  const words = [['(кстати', 0, 300], ...Array.from({ length: 8 }, (_, i) => [`слово${i}`, 300 + i * 300, 600 + i * 300])];

  const segments = parseWhisperJson(wordOutput(words));

  assert.equal(segments[0].words.length, 9);
});

test('зачитанная на тишине подсказка выбрасывается, а короткое совпадение с именем нет', () => {
  const prompt = 'Встреча «АБ платформа». Термины: АБ-тест, MDE. Участники: Irina Kozlova, Pavel Lebedev.';
  const segments = parseWhisperJson(
    wordOutput([
      ['Участники:', 0, 500],
      ['Irina', 500, 900],
      ['Kozlova,', 900, 1400],
      ['Pavel', 1400, 1700],
      ['Lebedev.', 1700, 2300],
      ['Pavel', 3000, 3300],
      ['Lebedev.', 3300, 3900],
    ]),
    { prompt },
  );

  assert.deepEqual(
    segments.map((s) => s.text),
    ['Pavel Lebedev.'],
  );
});
