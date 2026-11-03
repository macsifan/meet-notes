import { test } from 'node:test';
import assert from 'node:assert/strict';

import { noteFilename } from '../pipeline/run.mjs';

test('имя файла содержит местное время начала — встречи одного дня не затирают друг друга', () => {
  const morning = noteFilename('Синк', '2026-08-17T10:06:00+08:00', 'Asia/Makassar');
  const evening = noteFilename('Синк', '2026-08-17T18:06:00+08:00', 'Asia/Makassar');

  assert.notEqual(morning, evening);
  assert.match(morning, /^2026-08-17-1006-синк\.md$/);
  assert.match(evening, /^2026-08-17-1806-синк\.md$/);
});

test('время берётся в поясе встречи, а не в UTC', () => {
  // 13:06 UTC = 18:06 в поясе UTC+5
  const name = noteFilename('Встреча', '2026-08-17T13:06:00Z', 'Asia/Almaty');

  assert.match(name, /^2026-08-17-1806-встреча\.md$/);
});

test('без пояса времени имя всё равно собирается', () => {
  const name = noteFilename('Встреча', '2026-08-17T13:06:00Z');

  assert.match(name, /^2026-08-17-\d{4}-встреча\.md$/);
});

test('повторная обработка той же записи даёт то же имя', () => {
  const a = noteFilename('АБ платформа', '2026-08-17T10:06:00Z', 'Asia/Almaty');
  const b = noteFilename('АБ платформа', '2026-08-17T10:06:00Z', 'Asia/Almaty');

  assert.equal(a, b);
});
