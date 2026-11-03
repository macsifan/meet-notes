/**
 * Разбор подписи участника из плитки Meet.
 *
 * Meet склеивает в одну строку имя и всё, что нарисовано рядом: метку «(You)»,
 * роль «Meeting host», имена material-иконок вроде «front_hand» и подписи
 * кнопок. Так в лог попадало «Oleg Sokolov(You)Meeting hostfront_handLower»
 * вместо имени. Модуль общий: им пользуются и расширение, и пайплайн
 * (для записей, сделанных до этой правки).
 */

/** Метка, которой Meet отмечает плитку владельца записи. */
const SELF_MARK = /\((you|вы)\)/i;

/** С этих вставок начинается хвост, который к имени не относится. */
const TAIL = new RegExp(
  [
    SELF_MARK.source,
    'front_hand',
    'back_hand',
    'frame_person',
    'mic_off',
    'mic_none',
    'more_vert',
    'keep_off',
    'visual_effects',
    'meeting host',
    'организатор',
  ].join('|'),
  'i',
);

/**
 * @param {string|null|undefined} raw
 * @returns {{name: string, isSelf: boolean}|null}
 */
export function parseParticipantName(raw) {
  const text = (raw ?? '').trim();
  const isSelf = SELF_MARK.test(text);

  const cut = text.search(TAIL);
  const name = (cut >= 0 ? text.slice(0, cut) : text).trim();

  // Цифры — счётчики скрытых плиток («+2»), подчёркивание — недорезанная иконка.
  if (!name || /^\+?\d+$/.test(name) || name.includes('_')) return null;
  return { name, isSelf };
}

/**
 * Чистит список участников, сохраняя порядок и убирая дубли.
 * @param {string[]} rawNames
 * @returns {{participants: string[], selfName: string|null}}
 */
export function cleanParticipants(rawNames = []) {
  const participants = [];
  let selfName = null;

  for (const raw of rawNames) {
    const parsed = parseParticipantName(raw);
    if (!parsed) continue;
    if (parsed.isSelf && !selfName) selfName = parsed.name;
    if (!participants.includes(parsed.name)) participants.push(parsed.name);
  }
  return { participants, selfName };
}
