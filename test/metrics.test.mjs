import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWords, parseTranscript, alignWords, scoreTranscript } from '../pipeline/metrics.mjs';
import { sliceSpeakerEvents } from '../scripts/eval.mjs';

test('слова сравниваются без регистра, пунктуации и разницы «е/ё»', () => {
  assert.deepEqual(normalizeWords('Ещё раз: АБ-тест, всё!'), ['еще', 'раз', 'аб', 'тест', 'все']);
});

test('транскрипт «Имя: реплика» разбирается в слова с подписями', () => {
  const words = parseTranscript('# комментарий\nИван: Всем привет.\n?: Угу.\n');

  assert.deepEqual(words, [
    { speaker: 'Иван', word: 'всем' },
    { speaker: 'Иван', word: 'привет' },
    { speaker: null, word: 'угу' },
  ]);
});

test('WER считает замены, пропуски и вставки', () => {
  // эталон: «мы запускаем аб тест завтра», распознано: «мы запускаем оба теста завтра утром»
  const { errors } = alignWords(
    ['мы', 'запускаем', 'аб', 'тест', 'завтра'],
    ['мы', 'запускаем', 'оба', 'теста', 'завтра', 'утром'],
  );

  assert.equal(errors, 3);
});

test('оценка показывает ошибки в словаре и в подписях говорящих', () => {
  const reference = parseTranscript('Иван: Проверим SRM и MDE.\nМария: Хорошо.');
  const hypothesis = parseTranscript('Иван: Проверим эсэрэм и MDE.\nИван: Хорошо.');

  const score = scoreTranscript(reference, hypothesis, ['SRM', 'MDE', 'Confluence']);

  assert.equal(score.words, 5);
  assert.equal(score.wer, 1 / 5);
  assert.deepEqual(score.vocabulary, { expected: 2, found: 1, recall: 0.5, missed: ['SRM'] });
  assert.equal(score.speakers.checked, 4);
  assert.equal(score.speakers.accuracy, 3 / 4);
});

test('лог говорящих фрагмента начинается с того, кто говорил на его старте', () => {
  const events = [
    { t: 100, name: 'Иван' },
    { t: 650, name: 'Мария' },
    { t: 950, name: 'Пётр' },
  ];

  assert.deepEqual(sliceSpeakerEvents(events, 600, 900), [
    { t: 0, name: 'Иван' },
    { t: 50, name: 'Мария' },
  ]);
});
