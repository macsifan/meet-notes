/**
 * Подхват записей, оставшихся без заметки.
 *
 * Сервер могли перезапустить посреди обработки, у Claude мог кончиться лимит,
 * whisper мог упасть — во всех этих случаях аудио лежит на диске нетронутым.
 * При старте сервер находит такие записи и доводит их до заметки сам.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {{hasAudio: boolean, meta: object|null}} session
 * @returns {boolean}
 */
export function needsProcessing({ hasAudio, meta }) {
  if (!hasAudio || !meta) return false;
  if (meta.recording) return false; // запись ещё идёт прямо сейчас
  return !meta.processedNote;
}

/**
 * Читает состояние одной папки записи.
 * @param {string} dir
 */
async function readSession(dir) {
  const meta = await readFile(path.join(dir, 'meta.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const audioStat = await stat(path.join(dir, 'audio.webm')).catch(() => null);

  return {
    id: path.basename(dir),
    dir,
    meta,
    hasAudio: Boolean(audioStat && audioStat.size > 0),
    audioMtimeMs: audioStat?.mtimeMs ?? 0,
  };
}

/**
 * Находит записи, которые остались без заметки.
 *
 * minIdleMs отсекает записи, чьё аудио менялось только что: скорее всего,
 * они пишутся прямо сейчас, и подхватывать их рано.
 *
 * @param {string} recordingsDir
 * @param {{minIdleMs?: number}} options
 * @returns {Promise<{id: string, dir: string, meta: object}[]>}
 */
export async function findUnprocessed(recordingsDir, { minIdleMs = 3 * 60 * 1000 } = {}) {
  const entries = await readdir(recordingsDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(recordingsDir, e.name));

  const sessions = await Promise.all(dirs.map(readSession));
  const cutoff = Date.now() - minIdleMs;

  return sessions.filter((session) => needsProcessing(session) && session.audioMtimeMs <= cutoff);
}
