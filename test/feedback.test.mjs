import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speakingStats } from '../pipeline/feedback.mjs';
import { renderNote } from '../pipeline/render.mjs';

const long = (prefix) => `${prefix} ${'слово '.repeat(30).trim()}`;

const utterances = [
  { speaker: 'Иван', start: 0, end: 10, text: 'Давай обсудим сроки релиза.' },
  { speaker: 'Максим', start: 9, end: 40, text: long('Ну короче, типа, в общем, я думаю ну что успеем?') },
  { speaker: 'Максим', start: 41, end: 70, text: long('И ещё про стенд, на самом деле, он готов.') },
  { speaker: 'Иван', start: 72, end: 80, text: 'Хорошо.' },
  { speaker: 'Максим', start: 81, end: 90, text: 'А ты что думаешь?' },
];

test('доля эфира и ходы считаются по репликам владельца, подряд идущие склеиваются в один ход', () => {
  const stats = speakingStats(utterances, 'Максим');

  assert.equal(stats.selfSec, 69);
  assert.equal(stats.totalSec, 87);
  assert.equal(stats.turns, 2);
  assert.deepEqual(stats.longest, { sec: 61, start: 9 });
  assert.equal(stats.speakers, 2);
});

test('реплика, начатая заметно раньше конца чужой, считается перебиванием', () => {
  const stats = speakingStats(utterances, 'Максим');
  assert.equal(stats.interruptions, 1);
});

test('вопросы и слова-паразиты, включая составные, считаются по словам владельца', () => {
  const stats = speakingStats(utterances, 'Максим');

  assert.equal(stats.questions, 2);
  const counts = Object.fromEntries(stats.fillers.map((f) => [f.word, f.count]));
  assert.equal(counts['ну'], 2);
  assert.equal(counts['в общем'], 1);
  assert.equal(counts['на самом деле'], 1);
  assert.ok(stats.fillersPer100 > 0);
});

test('если владелец почти не говорил, разбора нет', () => {
  const quiet = [
    { speaker: 'Иван', start: 0, end: 60, text: long('Длинный рассказ') },
    { speaker: 'Максим', start: 61, end: 62, text: 'Ага.' },
  ];
  assert.equal(speakingStats(quiet, 'Максим'), null);
});

const meta = {
  title: 'Синк',
  startedAt: '2026-08-11T14:30:00+03:00',
  timezone: 'Europe/Moscow',
  durationSec: 90,
  participants: ['Иван', 'Максим'],
};

test('разбор попадает в заметку свёрнутым, с цифрами, цитатами и советами', () => {
  const stats = speakingStats(utterances, 'Максим');
  const advice = {
    verdict: 'Вовлечён, но говорит длинными заходами.',
    strengths: [{ point: 'Вовлекает собеседника вопросом', quote: 'А ты что думаешь?' }],
    improvements: [{ issue: 'Длинный заход перед мыслью', quote: 'Ну короче, типа', tip: 'Начинай с вывода.' }],
    practice: 'Каждую мысль начинай с одной фразы-вывода.',
  };
  const markdown = renderNote({ meta, summary: {}, utterances, review: { stats, advice } });

  assert.match(markdown, /<summary>Мой разбор: как я общаюсь<\/summary>/);
  assert.match(markdown, /\*\*Доля эфира\*\*: 79%/);
  assert.match(markdown, /> «А ты что думаешь\?»/);
  assert.match(markdown, /Как лучше: Начинай с вывода\./);
  assert.match(markdown, /### На следующую встречу/);
  assert.ok(markdown.indexOf('Мой разбор') < markdown.indexOf('Полный транскрипт'));
});

test('без ответа модели в разборе остаются одни цифры', () => {
  const stats = speakingStats(utterances, 'Максим');
  const markdown = renderNote({ meta, summary: {}, utterances, review: { stats, advice: null } });

  assert.match(markdown, /### В цифрах/);
  assert.doesNotMatch(markdown, /### Что поправить/);
});

test('без разбора заметка выглядит как раньше', () => {
  const markdown = renderNote({ meta, summary: {}, utterances });
  assert.doesNotMatch(markdown, /Мой разбор/);
  assert.match(markdown, /---\n\n<details>\n<summary>Полный транскрипт/);
});
