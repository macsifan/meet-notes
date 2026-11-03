import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { parseParticipantName, cleanParticipants } from '../extension/participant-name.js';
import { createTracker } from '../extension/speaker-detect.js';

test('склеенная с меткой «(You)» и иконками подпись даёт чистое имя владельца', () => {
  assert.deepEqual(parseParticipantName('Oleg Sokolov(You)Meeting hostfront_handLower'), {
    name: 'Oleg Sokolov',
    isSelf: true,
  });
});

test('имя иконки, приклеенное к чужому имени, отрезается', () => {
  assert.deepEqual(parseParticipantName('Ruslan Orlovfront_handLower'), {
    name: 'Ruslan Orlov',
    isSelf: false,
  });
});

test('русская метка «(Вы)» тоже отмечает владельца записи', () => {
  assert.deepEqual(parseParticipantName('Максим Колесников (Вы)'), {
    name: 'Максим Колесников',
    isSelf: true,
  });
});

test('счётчики скрытых плиток и голые иконки именами не считаются', () => {
  assert.equal(parseParticipantName('2'), null);
  assert.equal(parseParticipantName('+3'), null);
  assert.equal(parseParticipantName('frame_person'), null);
  assert.equal(parseParticipantName(''), null);
});

test('список участников из старой записи чистится от дублей и мусора', () => {
  // Реальный список из meta.json до правки разбора имён.
  const raw = [
    'Timur Belov',
    'Oleg Sokolov',
    'Ruslan Orlovfront_handLower',
    'Timur Belovfront_handLower',
    'Oleg Sokolov(You)Meeting hostfront_handLower',
    '2',
    'Ruslan Orlov',
  ];

  assert.deepEqual(cleanParticipants(raw), {
    participants: ['Timur Belov', 'Oleg Sokolov', 'Ruslan Orlov'],
    selfName: 'Oleg Sokolov',
  });
});

test('трекер отдаёт чистые имена и узнаёт плитку владельца записи', () => {
  const dom = new JSDOM(`
    <div data-participant-id="p1">
      <div>Oleg Sokolov</div><div>(You)</div><div>Meeting host</div><i>front_hand</i><span>Lower</span>
    </div>
    <div data-participant-id="p2"><div>Ruslan Orlov</div><i>front_hand</i><span>Lower</span></div>
    <div data-participant-id="p3"><div>2</div></div>
  `);
  const tracker = createTracker({ root: dom.window.document });

  tracker.start();
  tracker.stop();

  const log = tracker.getLog();
  assert.deepEqual(log.participants.sort(), ['Oleg Sokolov', 'Ruslan Orlov']);
  assert.equal(log.selfName, 'Oleg Sokolov');
});
