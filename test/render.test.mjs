import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderNote } from '../pipeline/render.mjs';

const meta = {
  title: 'Синк по интеграции',
  startedAt: '2026-08-11T14:30:00+03:00',
  timezone: 'Europe/Moscow',
  durationSec: 1920,
  participants: ['Иван', 'Мария'],
};

const summary = {
  summary: 'Обсудили сроки интеграции и распределили работы.',
  decisions: [{ what: 'Переносим релиз на 25 августа', context: 'Не успеваем нагрузочное' }],
  action_items: [
    {
      assignee: 'Мария',
      task: 'Настроить нагрузочный стенд',
      due: '15 августа',
      quote: 'Я возьму стенд на себя, к пятнице сделаю',
    },
  ],
  open_questions: [],
  risks: [],
};

const utterances = [
  { speaker: 'Иван', start: 5, end: 9, text: 'Кто возьмёт стенд?' },
  { speaker: 'Мария', start: 9, end: 14, text: 'Я возьму стенд на себя, к пятнице сделаю.' },
];

test('заголовком становится название встречи из Meet, а не придуманное моделью', () => {
  const markdown = renderNote({
    meta: { ...meta, title: 'Denis / Oleg' },
    summary: { ...summary, title: 'Проверка связи в начале встречи' },
    utterances,
  });

  assert.match(markdown, /^# Denis \/ Oleg/);
});

test('тема от модели сохраняется подзаголовком рядом с названием встречи', () => {
  const markdown = renderNote({
    meta: { ...meta, title: 'Denis / Oleg' },
    summary: { ...summary, title: 'Обсуждение сроков релиза' },
    utterances,
  });

  assert.match(markdown, /Обсуждение сроков релиза/);
});

test('без названия из Meet заголовок берётся от модели', () => {
  const markdown = renderNote({
    meta: { ...meta, title: '' },
    summary: { ...summary, title: 'Обсуждение сроков релиза' },
    utterances,
  });

  assert.match(markdown, /^# Обсуждение сроков релиза/);
});

test('в шапке есть название, дата встречи и участники', () => {
  const markdown = renderNote({ meta, summary, utterances });

  assert.match(markdown, /^# Синк по интеграции/);
  assert.match(markdown, /11 августа 2026/);
  assert.match(markdown, /Иван, Мария/);
});

test('длительность выводится в минутах', () => {
  const markdown = renderNote({ meta, summary, utterances });

  assert.match(markdown, /32 мин/);
});

test('короткая запись показывает секунды, а не «0 мин»', () => {
  const markdown = renderNote({ meta: { ...meta, durationSec: 40 }, summary, utterances });

  assert.match(markdown, /40 сек/);
  assert.doesNotMatch(markdown, /0 мин/);
});

test('длинная встреча показывается часами и минутами', () => {
  const markdown = renderNote({ meta: { ...meta, durationSec: 5460 }, summary, utterances });

  assert.match(markdown, /1 ч 31 мин/);
});

test('задача показывает исполнителя, срок и цитату-основание', () => {
  const markdown = renderNote({ meta, summary, utterances });

  assert.match(markdown, /\*\*Мария\*\*: Настроить нагрузочный стенд/);
  assert.match(markdown, /15 августа/);
  assert.match(markdown, /> «Я возьму стенд на себя, к пятнице сделаю»/);
});

test('срок с собственным предлогом не получает второй предлог', () => {
  const markdown = renderNote({
    meta,
    summary: {
      ...summary,
      action_items: [{ assignee: 'Иван', task: 'План миграции', due: 'до среды', quote: 'сделаю' }],
    },
    utterances,
  });

  assert.doesNotMatch(markdown, /до до среды/);
  assert.match(markdown, /План миграции · до среды/);
});

test('задача без срока не тянет за собой пустой разделитель', () => {
  const markdown = renderNote({
    meta,
    summary: {
      ...summary,
      action_items: [{ assignee: 'Иван', task: 'Позвонить подрядчику', due: '', quote: 'позвоню' }],
    },
    utterances,
  });

  assert.match(markdown, /\*\*Иван\*\*: Позвонить подрядчику\n/);
});

test('пустые разделы не попадают в заметку', () => {
  const markdown = renderNote({ meta, summary, utterances });

  assert.doesNotMatch(markdown, /Открытые вопросы/);
  assert.doesNotMatch(markdown, /Риски/);
});

test('транскрипт содержит реплики с таймкодами и именами', () => {
  const markdown = renderNote({ meta, summary, utterances });

  assert.match(markdown, /\[00:09\] \*\*Мария:\*\* Я возьму стенд на себя/);
});

test('реплики без опознанного спикера подписаны как неизвестный участник', () => {
  const markdown = renderNote({
    meta,
    summary,
    utterances: [{ speaker: null, start: 0, end: 2, text: 'Всем привет.' }],
  });

  assert.match(markdown, /\*\*\?:\*\* Всем привет\./);
});

test('в собранной заметке нет длинных тире', () => {
  const markdown = renderNote({ meta, summary, utterances });

  assert.doesNotMatch(markdown, /[—–]/);
});
