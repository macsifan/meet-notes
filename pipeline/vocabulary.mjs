/**
 * Словарь встречи: имена участников и термины, которые Whisper иначе коверкает
 * («оба-тесты» вместо «АБ-тестов», «конфьюенс» вместо Confluence).
 *
 * Whisper принимает начальный текст как будто предыдущую речь и после этого
 * пишет встреченные в нём слова правильно. Глоссарий — файл data/glossary.txt,
 * по термину на строку, # начинает комментарий.
 */

import { readFile } from 'node:fs/promises';

/**
 * Whisper берёт из подсказки не больше 224 токенов и при переполнении
 * отбрасывает начало. Кириллица дорогая (2-3 символа на токен), поэтому
 * держимся с запасом, а имена ставим в конец: они важнее терминов.
 */
const MAX_PROMPT_CHARS = 450;

/**
 * @param {string} text содержимое файла глоссария
 * @returns {string[]}
 */
export function parseGlossary(text) {
  const terms = text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
  return [...new Set(terms)];
}

/** Отсутствующий файл — не ошибка: глоссарий необязателен. */
export async function loadGlossary(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return parseGlossary(text);
}

/**
 * @param {{title?: string, participants?: string[], glossary?: string[]}} vocabulary
 * @returns {string} пустая строка, если подсказывать нечего
 */
export function buildWhisperPrompt({ title, participants = [], glossary = [] }) {
  const head = title ? `Встреча «${title}».` : '';
  const names = participants.length ? `Участники: ${participants.join(', ')}.` : '';

  // Термины добавляются, пока влезают: имена и название не режутся никогда.
  let budget = MAX_PROMPT_CHARS - head.length - names.length - 'Термины: .'.length - 2;
  const terms = [];
  for (const term of glossary) {
    const cost = term.length + 2;
    if (cost > budget) break;
    terms.push(term);
    budget -= cost;
  }

  return [head, terms.length ? `Термины: ${terms.join(', ')}.` : '', names]
    .filter(Boolean)
    .join(' ');
}
