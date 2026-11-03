import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markdownToHtml, extractNoteHeader } from '../server/markdown.mjs';

const NOTE = `# Denis / Oleg

**11 августа 2026 г., 14:36** · 20 сек · Иван, Мария

*Проверка звука перед началом встречи*

## Решения
`;

test('из заметки читается название встречи', () => {
  assert.equal(extractNoteHeader(NOTE).title, 'Denis / Oleg');
});

test('из заметки читается время её проведения', () => {
  assert.equal(extractNoteHeader(NOTE).when, '11 августа 2026 г., 14:36 · 20 сек · Иван, Мария');
});

test('заметка без шапки не ломает разбор', () => {
  const header = extractNoteHeader('просто текст');

  assert.equal(header.title, null);
  assert.equal(header.when, null);
});

test('заголовки становятся тегами нужного уровня', () => {
  assert.match(markdownToHtml('# Встреча'), /<h1>Встреча<\/h1>/);
  assert.match(markdownToHtml('## Задачи'), /<h2>Задачи<\/h2>/);
});

test('пункты списка собираются в один список', () => {
  const html = markdownToHtml('- первый\n- второй');

  assert.match(html, /<ul>\s*<li>первый<\/li>\s*<li>второй<\/li>\s*<\/ul>/);
});

test('жирный текст переносится в разметку', () => {
  assert.match(markdownToHtml('- **Мария** — стенд'), /<strong>Мария<\/strong>/);
});

test('цитата-основание оформляется отдельно', () => {
  assert.match(markdownToHtml('> «сделаю к пятнице»'), /<blockquote>«сделаю к пятнице»<\/blockquote>/);
});

test('html из заметки не ломает страницу', () => {
  assert.match(markdownToHtml('Сравнили a < b и c > d'), /a &lt; b и c &gt; d/);
});

test('блок с транскриптом остаётся сворачиваемым', () => {
  const html = markdownToHtml('<details>\n<summary>Полный транскрипт</summary>\n\nтекст\n\n</details>');

  assert.match(html, /<details>/);
  assert.match(html, /<summary>Полный транскрипт<\/summary>/);
});
