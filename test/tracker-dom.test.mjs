/**
 * Проверка детекта на эмуляции разметки Meet: молчащие плитки статичны,
 * у говорящего анимируется индикатор речи и сыплет DOM-мутациями.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createTracker } from '../extension/speaker-detect.js';
import { meetLikeDom, speakFor, settle } from './helpers.mjs';

const TRACKER_OPTIONS = { windowMs: 30, threshold: 4, stableWindows: 3 };

test('имя из плитки Meet читается без продублированной подписи', () => {
  // Так выглядит настоящая плитка: имя лежит в разметке дважды.
  const dom = new JSDOM(`
    <div data-participant-id="spaces/6RmZtwZS7c8B/devices/144">
      <div>Oleg Sokolov</div><div>Oleg Sokolov</div>
    </div>
  `);
  const tracker = createTracker({ root: dom.window.document });

  tracker.start();
  tracker.stop();

  assert.deepEqual(tracker.getLog().participants, ['Oleg Sokolov']);
});

test('состав участников считывается с плиток встречи', () => {
  const document = meetLikeDom();
  const tracker = createTracker({ root: document });

  tracker.start();
  tracker.stop();

  assert.deepEqual(tracker.getLog().participants.sort(), ['Иван', 'Мария']);
});

test('говорящего определяет активность его плитки', async () => {
  const document = meetLikeDom();
  const tracker = createTracker({ root: document, ...TRACKER_OPTIONS });

  tracker.start();
  await speakFor(document, 'p2', 200);
  tracker.stop();

  const { speakerEvents } = tracker.getLog();
  assert.ok(speakerEvents.length > 0, 'ожидалось хотя бы одно событие');
  assert.equal(speakerEvents[0].name, 'Мария');
});

test('смена говорящего отражается в логе по порядку', async () => {
  const document = meetLikeDom();
  const tracker = createTracker({ root: document, ...TRACKER_OPTIONS });

  tracker.start();
  await speakFor(document, 'p1', 200);
  await speakFor(document, 'p2', 200);
  tracker.stop();

  const names = tracker.getLog().speakerEvents.map((event) => event.name);
  assert.deepEqual(
    names.filter(Boolean),
    ['Иван', 'Мария'],
    `неожиданная последовательность: ${JSON.stringify(names)}`,
  );
});

test('общая тишина не приписывается никому', async () => {
  const document = meetLikeDom();
  const tracker = createTracker({ root: document, ...TRACKER_OPTIONS });

  tracker.start();
  await settle(150);
  tracker.stop();

  assert.deepEqual(tracker.getLog().speakerEvents, []);
});
