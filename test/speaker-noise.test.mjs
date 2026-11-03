/**
 * Устойчивость детекта к шуму: служебные подписи Meet и короткие всплески
 * активности не должны попадать в лог говорящих.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createTracker } from '../extension/speaker-detect.js';

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Непрерывная «речь»: индикатор дрожит всё время, как в настоящем Meet. */
async function speakFor(document, id, ms) {
  const mic = document.querySelector(`[data-participant-id="${id}"] .mic`);
  const until = Date.now() + ms;
  let step = 0;
  while (Date.now() < until) {
    for (let i = 0; i < 5; i++) mic.style.height = `${step++ % 5}px`;
    await settle(5);
  }
}

test('название иконки Meet не считается участником', () => {
  const dom = new JSDOM(`
    <div data-participant-id="p1"><i>frame_person</i></div>
    <div data-participant-id="p2"><div>Oleg Sokolov</div></div>
  `);
  const tracker = createTracker({ root: dom.window.document });

  tracker.start();
  tracker.stop();

  assert.deepEqual(tracker.getLog().participants, ['Oleg Sokolov']);
});

test('плитка демонстрации экрана не считается участником', () => {
  const dom = new JSDOM(`
    <div data-participant-id="p1"><div>Oleg Sokolov (Your presentation)</div></div>
    <div data-participant-id="p2"><div>Irina Kozlova</div></div>
  `);
  const tracker = createTracker({ root: dom.window.document });

  tracker.start();
  tracker.stop();

  assert.deepEqual(tracker.getLog().participants, ['Irina Kozlova']);
});

test('интерфейсный текст Meet не принимается за имя', () => {
  const dom = new JSDOM(`
    <div data-participant-id="p1"><div>Others might still see your full video.</div></div>
    <div data-participant-id="p2"><div>Oleg Sokolov</div></div>
  `);
  const tracker = createTracker({ root: dom.window.document });

  tracker.start();
  tracker.stop();

  assert.deepEqual(tracker.getLog().participants, ['Oleg Sokolov']);
});

test('у участника без видео имя берётся из подписи плитки', () => {
  const dom = new JSDOM(`
    <div data-participant-id="p1" aria-label="Denis Morozov"><i>frame_person</i></div>
  `);
  const tracker = createTracker({ root: dom.window.document });

  tracker.start();
  tracker.stop();

  assert.deepEqual(tracker.getLog().participants, ['Denis Morozov']);
});

test('мгновенный всплеск чужой плитки не перебивает говорящего', async () => {
  const dom = new JSDOM(`
    <div data-participant-id="p1"><div>Иван</div><div class="mic"></div></div>
    <div data-participant-id="p2"><div>Мария</div><div class="mic"></div></div>
  `);
  const document = dom.window.document;
  const tracker = createTracker({ root: document, windowMs: 30, threshold: 4, stableWindows: 3 });

  tracker.start();
  await speakFor(document, 'p1', 200); // Иван говорит устойчиво
  await speakFor(document, 'p2', 30); // Мария кашлянула в одно окно
  await speakFor(document, 'p1', 200);
  tracker.stop();

  const names = tracker.getLog().speakerEvents.map((event) => event.name);
  assert.deepEqual(names, ['Иван'], `лог дёргается: ${JSON.stringify(names)}`);
});

test('устойчивая смена говорящего всё равно фиксируется', async () => {
  const dom = new JSDOM(`
    <div data-participant-id="p1"><div>Иван</div><div class="mic"></div></div>
    <div data-participant-id="p2"><div>Мария</div><div class="mic"></div></div>
  `);
  const document = dom.window.document;
  const tracker = createTracker({ root: document, windowMs: 30, threshold: 4, stableWindows: 3 });

  tracker.start();
  await speakFor(document, 'p1', 200);
  await speakFor(document, 'p2', 200);
  tracker.stop();

  const names = tracker.getLog().speakerEvents.map((event) => event.name);
  assert.deepEqual(names, ['Иван', 'Мария'], `неожиданный лог: ${JSON.stringify(names)}`);
});
