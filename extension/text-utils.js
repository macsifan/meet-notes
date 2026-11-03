/**
 * Meet дублирует подписи: имя участника и название встречи лежат в разметке
 * дважды (видимый текст плюс копия для скринридера). При чтении через
 * textContent это превращается в «Oleg SokolovOleg Sokolov».
 */

/**
 * Приводит текст из разметки Meet к читаемому виду.
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function readableText(raw) {
  const firstLine = (raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return '';

  // Строка, склеенная сама с собой: «имяимя» → «имя».
  const half = firstLine.length / 2;
  if (Number.isInteger(half) && firstLine.slice(0, half) === firstLine.slice(half)) {
    return firstLine.slice(0, half).trim();
  }

  return firstLine;
}
