import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickActive, appendSpeakerEvent } from '../extension/speaker-detect.js';

test('говорит тот, чья плитка дрожит сильнее всех', () => {
  const activity = new Map([
    ['Иван', 12],
    ['Мария', 2],
  ]);

  assert.equal(pickActive(activity, 5), 'Иван');
});

test('слабая активность считается тишиной, а не речью', () => {
  const activity = new Map([
    ['Иван', 2],
    ['Мария', 1],
  ]);

  assert.equal(pickActive(activity, 5), null);
});

test('при полном отсутствии активности говорящего нет', () => {
  assert.equal(pickActive(new Map(), 5), null);
});

test('повтор того же говорящего не засоряет лог', () => {
  const events = [{ t: 0, name: 'Иван' }];

  appendSpeakerEvent(events, 3.5, 'Иван');

  assert.equal(events.length, 1);
});

test('смена говорящего попадает в лог с меткой времени', () => {
  const events = [{ t: 0, name: 'Иван' }];

  appendSpeakerEvent(events, 3.5, 'Мария');

  assert.deepEqual(events.at(-1), { t: 3.5, name: 'Мария' });
});

test('наступившая тишина отмечается в логе', () => {
  const events = [{ t: 0, name: 'Иван' }];

  appendSpeakerEvent(events, 4, null);

  assert.deepEqual(events.at(-1), { t: 4, name: null });
});

test('лог начинается с первого же говорящего', () => {
  const events = [];

  appendSpeakerEvent(events, 1.2, 'Иван');

  assert.deepEqual(events, [{ t: 1.2, name: 'Иван' }]);
});

test('тишина в самом начале не создаёт пустую запись', () => {
  const events = [];

  appendSpeakerEvent(events, 0.5, null);

  assert.deepEqual(events, []);
});
