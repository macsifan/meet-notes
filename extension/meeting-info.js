/**
 * Определение названия встречи.
 *
 * Заголовок вкладки у Meet часто показывает не название встречи, а участников
 * («Denis / Oleg») или просто код, поэтому название ищется в нескольких
 * местах, а все найденные варианты сохраняются в метаданных записи —
 * по ним видно, что было доступно, если выбор окажется неудачным.
 */

import { readableText } from './text-utils.js';

/** Код вида abc-defg-hij: сам по себе он не название, но годится как запасной вариант. */
const MEETING_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Мусор, который Meet кладёт в заголовок вкладки. */
const TITLE_NOISE = /^(meet|google meet|встреча)$/i;

const MAX_TITLE_LENGTH = 80;

function cleanTitle(text) {
  return readableText(text)
    .replace(/^Meet\s*[—–-]\s*/i, '')
    .replace(/\s*[—–-]\s*Google Meet$/i, '')
    .trim();
}

function isUsable(text, meetingCode) {
  return Boolean(
    text && text.length <= MAX_TITLE_LENGTH && text !== meetingCode && !TITLE_NOISE.test(text),
  );
}

/**
 * @param {Document} document
 * @param {Location} location
 * @returns {{panel: string[], documentTitle: string, meetingCode: string}}
 */
export function collectTitleCandidates(document, location) {
  const meetingCode = (location.pathname ?? '').replace(/^\//, '').split(/[?#]/)[0];

  const fromAttributes = [...document.querySelectorAll('[data-meeting-title], [data-call-title]')]
    .map((element) => element.getAttribute('data-meeting-title') ?? element.getAttribute('data-call-title'))
    .map((value) => cleanTitle(value));

  const fromHeadings = [...document.querySelectorAll('[role="heading"], h1, h2')].map((element) =>
    cleanTitle(element.textContent),
  );

  const panel = [...new Set([...fromAttributes, ...fromHeadings])].filter((text) =>
    isUsable(text, meetingCode),
  );

  return { panel, documentTitle: document.title ?? '', meetingCode };
}

/**
 * @param {{panel: string[], documentTitle: string, meetingCode: string}} candidates
 * @returns {string}
 */
export function pickTitle({ panel = [], documentTitle = '', meetingCode = '' }) {
  // Кандидаты чистятся и здесь: они могут прийти как есть, без сбора через collectTitleCandidates.
  const fromPanel = panel.map(cleanTitle).find((text) => isUsable(text, meetingCode));
  if (fromPanel) return fromPanel;

  const fromTab = cleanTitle(documentTitle);
  if (isUsable(fromTab, meetingCode)) return fromTab;

  return meetingCode || 'Встреча в Google Meet';
}
