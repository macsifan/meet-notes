#!/usr/bin/env node
/**
 * Локальный приёмник записей встреч.
 *
 * Расширение стримит аудио чанками по 5 секунд, поэтому падение Chrome
 * стоит максимум одного чанка. По /finish запись уходит в очередь обработки.
 *
 * Слушает только 127.0.0.1 — наружу ничего не открывается.
 */

import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processRecording } from '../pipeline/run.mjs';
import { markdownToHtml, extractNoteHeader } from './markdown.mjs';
import { findUnprocessed } from './recovery.mjs';

const PAGE_STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1f1f1f; --muted:#5f6368; --line:#e3e3e3; --accent:#1a73e8; }
@media (prefers-color-scheme: dark) { :root { --bg:#181818; --fg:#e8eaed; --muted:#9aa0a6; --line:#3c4043; } }
* { box-sizing: border-box; }
body { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  margin: 32px 0 12px; }
p { margin: 0 0 12px; }
ul { margin: 0 0 12px; padding-left: 22px; }
li { margin: 0 0 8px; }
blockquote { margin: -4px 0 12px 22px; padding-left: 12px; border-left: 2px solid var(--line);
  color: var(--muted); font-size: 15px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
details { color: var(--muted); font-size: 15px; }
summary { cursor: pointer; color: var(--fg); font-weight: 500; margin-bottom: 12px; }
.notes { list-style: none; padding: 0; }
.notes li { margin: 0 0 2px; }
.notes a { display: block; padding: 12px 14px; border-radius: 10px; color: var(--fg); }
.notes a:hover { background: rgba(128,128,128,.12); text-decoration: none; }
.date { color: var(--muted); font-size: 13px; }
.back { display: inline-block; margin-bottom: 24px; font-size: 14px; }
.empty { color: var(--muted); }
`;

function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDINGS = path.join(ROOT, 'data', 'recordings');
const NOTES = path.join(ROOT, 'data', 'notes');
const PORT = Number(process.env.MEET_NOTES_PORT ?? 8788);

/** id приходит из браузера и попадает в путь на диске — пускаем только безопасные. */
const SAFE_ID = /^[a-zA-Z0-9-]{6,64}$/;

const queue = [];
const state = new Map();
let working = false;

function sessionDir(id) {
  return path.join(RECORDINGS, id);
}

function setState(id, status, extra = {}) {
  state.set(id, { id, status, updatedAt: new Date().toISOString(), ...extra });
}

async function enqueue(id) {
  queue.push(id);
  setState(id, 'в очереди');
  if (!working) void drainQueue();
}

/** Записи обрабатываются по одной: whisper на 16 ГБ не любит соседей. */
async function drainQueue() {
  working = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      const metaPath = path.join(sessionDir(id), 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      const audioPath = path.join(sessionDir(id), 'audio.webm');
      const { notePath } = await processRecording(audioPath, meta, {
        outDir: NOTES,
        onStage: (stage) => {
          setState(id, stage);
          console.log(`[${id}] ${stage}`);
        },
      });
      // Отметка в meta.json: по ней восстановление отличает обработанное от брошенного.
      await writeFile(
        metaPath,
        JSON.stringify({ ...meta, processedNote: path.basename(notePath) }, null, 2),
        'utf8',
      );
      setState(id, 'готово', { note: path.basename(notePath) });
      console.log(`[${id}] ✓ ${notePath}`);
    } catch (error) {
      setState(id, 'ошибка', { error: error.message });
      console.error(`[${id}] ✗ ${error.message}`);
    }
  }
  working = false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (chunk) => parts.push(chunk));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

/** Чанк дописывается в конец: последовательные фрагменты MediaRecorder склеиваются в валидный webm. */
async function appendChunk(id, buffer) {
  await mkdir(sessionDir(id), { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(path.join(sessionDir(id), 'audio.webm'), { flags: 'a' });
    stream.on('error', reject);
    stream.end(buffer, resolve);
  });
}

/** Название и время берём из самой заметки: имя файла — это slug, читать его неудобно. */
async function noteSummary(file) {
  const fullPath = path.join(NOTES, file);
  const [content, stats] = await Promise.all([readFile(fullPath, 'utf8'), stat(fullPath)]);
  const header = extractNoteHeader(content);

  return {
    file,
    title: header.title ?? file.replace(/\.md$/, ''),
    when: header.when ?? file.slice(0, 10),
    mtime: stats.mtimeMs,
  };
}

async function listNotes() {
  await mkdir(NOTES, { recursive: true });
  const files = (await readdir(NOTES)).filter((f) => f.endsWith('.md'));
  const notes = await Promise.all(files.map(noteSummary));
  return notes.sort((a, b) => b.mtime - a.mtime);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'POST' && segments[0] === 'ingest') {
    const [, id, action] = segments;
    if (!SAFE_ID.test(id ?? '')) return sendJson(res, 400, { error: 'некорректный id сессии' });

    if (action === 'meta') {
      const meta = JSON.parse((await readBody(req)).toString('utf8'));
      await mkdir(sessionDir(id), { recursive: true });
      await writeFile(path.join(sessionDir(id), 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      setState(id, 'идёт запись');
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'chunk') {
      await appendChunk(id, await readBody(req));
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'finish') {
      const metaPath = path.join(sessionDir(id), 'meta.json');
      const previous = JSON.parse(await readFile(metaPath, 'utf8').catch(() => '{}'));
      const body = (await readBody(req)).toString('utf8');
      const meta = body.trim() ? { ...previous, ...JSON.parse(body) } : previous;

      // Случайный секундный старт (дёрнулся автозапуск, тут же остановился) —
      // не встреча: заметку из «Uh» делать не из чего.
      if ((meta.durationSec ?? 0) < 15) {
        meta.processedNote = '(пропущено: запись короче 15 секунд)';
        await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        setState(id, 'пропущено (слишком короткая запись)');
        return sendJson(res, 200, { ok: true, status: 'пропущено' });
      }

      if (body.trim()) {
        await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      }
      await enqueue(id);
      return sendJson(res, 202, { ok: true, status: 'в очереди' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    return sendJson(res, 200, { queue: queue.length, sessions: [...state.values()] });
  }

  if (req.method === 'GET' && segments[0] === 'notes' && segments[1]) {
    const file = path.basename(decodeURIComponent(segments[1]));
    const content = await readFile(path.join(NOTES, file), 'utf8').catch(() => null);
    if (content === null) return sendJson(res, 404, { error: 'заметка не найдена' });

    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file;
    const body = `<a class="back" href="/">← Все заметки</a>\n${markdownToHtml(content)}`;
    return send(res, 200, page(heading, body), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const notes = await listNotes();
    const processing = [...state.values()].filter(
      (s) => s.status !== 'готово' && s.status !== 'ошибка',
    );

    const items = notes
      .map(
        (note) =>
          `<li><a href="/notes/${encodeURIComponent(note.file)}">${note.title}<br /><span class="date">${note.when}</span></a></li>`,
      )
      .join('\n');

    const body = [
      '<h1>Заметки встреч</h1>',
      processing.length
        ? `<p class="empty">Сейчас обрабатывается: ${processing.map((s) => s.status).join(', ')}</p>`
        : '',
      items ? `<ul class="notes">${items}</ul>` : '<p class="empty">Пока пусто — запишите первую встречу.</p>',
    ].join('\n');

    return send(res, 200, page('Заметки встреч', body), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  sendJson(res, 404, { error: 'не найдено' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    sendJson(res, 500, { error: error.message });
  });
});

/**
 * Подхват записей, оставшихся без заметки: сервер могли перезапустить посреди
 * обработки, у Claude мог кончиться лимит, whisper мог упасть.
 */
async function recoverAbandoned() {
  const abandoned = await findUnprocessed(RECORDINGS);
  for (const session of abandoned) {
    console.log(`[${session.id}] найдена необработанная запись — ставлю в очередь`);
    await enqueue(session.id);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`meet-notes слушает http://127.0.0.1:${PORT}`);
  recoverAbandoned().catch((error) => console.error('восстановление не удалось:', error));
});
