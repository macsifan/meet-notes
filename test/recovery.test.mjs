import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { needsProcessing, findUnprocessed } from '../server/recovery.mjs';

async function makeSession(root, id, { audio = true, meta = {}, audioAgeMs = 60 * 60 * 1000 } = {}) {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
  if (audio) {
    const audioPath = path.join(dir, 'audio.webm');
    await writeFile(audioPath, 'x'.repeat(100));
    const when = new Date(Date.now() - audioAgeMs);
    await utimes(audioPath, when, when);
  }
  return dir;
}

test('брошенная запись находится, а свежая и обработанная — нет', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-'));
  await makeSession(root, 'abandoned', { meta: { title: 'Встреча' } });
  await makeSession(root, 'done', { meta: { title: 'Встреча', processedNote: 'x.md' } });
  // Аудио менялось только что — запись, скорее всего, ещё идёт.
  await makeSession(root, 'live', { meta: { title: 'Встреча' }, audioAgeMs: 10 * 1000 });
  await makeSession(root, 'ghost', { audio: false, meta: { title: 'Встреча' } });

  const found = await findUnprocessed(root, { minIdleMs: 3 * 60 * 1000 });

  assert.deepEqual(
    found.map((s) => s.id),
    ['abandoned'],
  );
});

test('запись без отметки об обработке требует внимания', () => {
  assert.equal(needsProcessing({ hasAudio: true, meta: { title: 'Встреча' } }), true);
});

test('уже собранная заметка повторно не обрабатывается', () => {
  assert.equal(
    needsProcessing({ hasAudio: true, meta: { processedNote: '2026-08-11-встреча.md' } }),
    false,
  );
});

test('запись без аудио пропускается', () => {
  assert.equal(needsProcessing({ hasAudio: false, meta: { title: 'Встреча' } }), false);
});

test('незавершённая запись без метаданных пропускается', () => {
  assert.equal(needsProcessing({ hasAudio: true, meta: null }), false);
});

test('запись, упавшая с ошибкой, берётся в работу снова', () => {
  assert.equal(
    needsProcessing({ hasAudio: true, meta: { title: 'Встреча', error: 'claude недоступен' } }),
    true,
  );
});

test('запись, которая ещё пишется, не трогается', () => {
  assert.equal(
    needsProcessing({ hasAudio: true, meta: { title: 'Встреча', recording: true } }),
    false,
  );
});
