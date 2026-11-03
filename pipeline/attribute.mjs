/**
 * Сшивка сегментов Whisper с логом активного говорящего из Meet.
 *
 * Whisper не различает голоса, поэтому имена берутся из двух источников:
 * - канал стерео-записи: слова из канала микрофона принадлежат владельцу
 *   записи, и это надёжнее любого DOM (свою плитку Meet не подсвечивает);
 * - лог Meet: content script пишет события «с момента t говорит X»
 *   (name === null — никто), по нему различаются собеседники.
 *
 * Если у сегмента есть слова с таймкодами, он режется на смене канала:
 * иначе «Готово? — Да.» целиком доставалось одному человеку. Лог Meet
 * запаздывает и дрожит, поэтому внутри одной фразы он не режет, а выбирает
 * автора: границы между людьми Whisper и так ставит точкой.
 */

import { parseParticipantName } from '../extension/participant-name.js';

/**
 * Имена material-иконок вроде «frame_person»: Meet рисует их текстом в плитках
 * без видео, откуда они могут попасть в лог. Пайплайн такому входу не доверяет.
 */
const ICON_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

function sanitizeName(name) {
  const parsed = parseParticipantName(name);
  return parsed && !ICON_NAME.test(parsed.name) ? parsed.name : null;
}

/**
 * Превращает список событий в непрерывные интервалы владения микрофоном.
 * @param {{t: number, name: string|null}[]} speakerEvents
 */
function toZones(speakerEvents) {
  const sorted = [...speakerEvents]
    .map((event) => ({ ...event, name: sanitizeName(event.name) }))
    .sort((a, b) => a.t - b.t);
  return sorted.map((event, i) => ({
    start: event.t,
    end: i + 1 < sorted.length ? sorted[i + 1].t : Infinity,
    name: event.name,
  }));
}

function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Кто говорил дольше всех внутри интервала сегмента.
 * Зоны тишины не участвуют: детект активного спикера отстаёт от речи
 * на доли секунды, и без этого правила короткие паузы забирали бы реплику.
 */
function dominantSpeaker(segment, zones) {
  const spoken = new Map();
  for (const zone of zones) {
    if (zone.name === null) continue;
    const seconds = overlap(segment, zone);
    if (seconds > 0) spoken.set(zone.name, (spoken.get(zone.name) ?? 0) + seconds);
  }

  let winner = null;
  let best = 0;
  for (const [name, seconds] of spoken) {
    if (seconds > best) {
      winner = name;
      best = seconds;
    }
  }
  return winner;
}

/** Подпись реплик владельца записи, если Meet не выдал его имя. */
export const SELF_FALLBACK = 'Я';

/** Кто говорит в момент t по логу Meet. */
function zoneAt(zones, t) {
  return zones.find((zone) => zone.start <= t && t < zone.end)?.name ?? null;
}

/**
 * Момент, по которому слово сверяется с логом. Конец слова Whisper тянет
 * до следующего, поэтому середина слова ненадёжна: берём начало с запасом.
 */
function probeTime(word) {
  return word.start + Math.min(0.3, (word.end - word.start) / 2);
}

/**
 * Имя для каждого слова. undefined — источник молчит, имя возьмём у соседей.
 * @returns {{name: string|null|undefined, sure: boolean}[]}
 */
function labelWords(words, zones, { selfLabel, selfName, onlyRemote }) {
  return words.map((word) => {
    if (word.channel === 'mic') return { name: selfLabel, sure: true };

    const fromLog = zoneAt(zones, probeTime(word));
    if (word.channel === 'tab') {
      // Голос пришёл из вкладки, значит это не владелец, что бы ни показал лог.
      const name = fromLog && fromLog !== selfName ? fromLog : onlyRemote;
      return { name: name ?? undefined, sure: false };
    }
    return { name: fromLog ?? undefined, sure: false };
  });
}

/**
 * Дальше этого имя соседа на слово без имени не переносится. Голос из
 * вкладки точно чужой, ему можно искать имя подальше. Без канала пауза
 * лога длиннее запаздывания Meet — скорее речь владельца записи, чью
 * плитку Meet не подсвечивает: такие слова остаются безымянными.
 */
const MAX_FILL_GAP_SEC = { tab: 5, unknown: 1.5 };

/**
 * Слово без имени получает имя ближайшего по времени соседа. При равенстве
 * побеждает следующий: Meet подсвечивает плитку с опозданием, и начало
 * реплики обычно попадает в паузу лога перед её владельцем.
 * Слово из вкладки никогда не получает имя по слову из микрофона.
 */
function fillGaps(words, labels) {
  const compatible = (i, j) => !(words[i].channel === 'tab' && labels[j].sure);

  return labels.map((label, i) => {
    if (label.name !== undefined) return label;

    let previous = i - 1;
    while (previous >= 0 && (labels[previous].name === undefined || !compatible(i, previous))) previous -= 1;
    let next = i + 1;
    while (next < labels.length && (labels[next].name === undefined || !compatible(i, next))) next += 1;

    const gapBefore = previous >= 0 ? words[i].start - words[previous].end : Infinity;
    const gapAfter = next < labels.length ? words[next].start - words[i].end : Infinity;
    const source = gapAfter <= gapBefore ? next : previous;
    const gap = Math.min(gapBefore, gapAfter);

    const limit = words[i].channel === 'tab' ? MAX_FILL_GAP_SEC.tab : MAX_FILL_GAP_SEC.unknown;
    return { name: gap <= limit ? labels[source].name : null, sure: false };
  });
}

/**
 * Внутри фразы слова без канала микрофона получают одно имя: то, что чаще
 * всех встречается среди них. Так дрожание лога Meet не рвёт фразу.
 * Если среди них есть голос из вкладки, владелец записи автором быть не может.
 */
function settleStretches(words, labels, selfLabel) {
  const settled = labels.map((label) => ({ ...label }));
  let i = 0;
  while (i < settled.length) {
    if (settled[i].sure) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < settled.length && !settled[end].sure) end += 1;

    const fromTab = words.slice(i, end).some((word) => word.channel === 'tab');
    const votes = new Map();
    for (let k = i; k < end; k++) {
      const { name } = settled[k];
      if (name && !(fromTab && name === selfLabel)) votes.set(name, (votes.get(name) ?? 0) + 1);
    }
    const winner = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    for (let k = i; k < end; k++) settled[k].name = winner;
    i = end;
  }
  return settled;
}

function toRuns(words, labels) {
  const runs = [];
  for (const [i, word] of words.entries()) {
    const { name } = labels[i];
    const previous = runs.at(-1);
    if (previous && previous.name === name) previous.words.push(word);
    else runs.push({ name, words: [word] });
  }
  return runs;
}

/**
 * @param {Map<object, {name: string|null, sure: boolean}>} labelOf имя каждого слова
 * @param {string} selfLabel подпись владельца записи
 * @returns {{speaker: string|null, start: number, end: number, text: string}[]}
 */
function splitBySpeaker(segment, zones, labelOf, selfLabel) {
  if (!segment.words?.length) {
    return [{ speaker: dominantSpeaker(segment, zones), start: segment.start, end: segment.end, text: segment.text.trim() }];
  }

  const labels = settleStretches(
    segment.words,
    segment.words.map((word) => labelOf.get(word)),
    selfLabel,
  );
  return toRuns(segment.words, labels).map((run) => ({
    speaker: run.name,
    start: run.words[0].start,
    end: run.words.at(-1).end,
    text: run.words.map((word) => word.text).join(' ').trim(),
  }));
}

/**
 * Пауза длиннее этой — граница реплики даже без смены говорящего.
 * Держит транскрипт читаемым, когда лог говорящих пуст.
 */
const MAX_MERGE_GAP_SEC = 15;

/**
 * Предел склейки: длинный монолог режется на абзацы такого размера,
 * иначе час презентации слипается в один нечитаемый блок.
 */
const MAX_UTTERANCE_CHARS = 1000;

/** Соседние сегменты одного человека — это одна реплика, а не список обрывков. */
function mergeConsecutive(utterances) {
  const merged = [];
  for (const utterance of utterances) {
    const previous = merged.at(-1);
    const gap = previous ? utterance.start - previous.end : 0;
    if (
      previous &&
      previous.speaker === utterance.speaker &&
      gap <= MAX_MERGE_GAP_SEC &&
      previous.text.length + utterance.text.length <= MAX_UTTERANCE_CHARS
    ) {
      previous.end = utterance.end;
      previous.text = `${previous.text} ${utterance.text}`.trim();
    } else {
      merged.push({ ...utterance });
    }
  }
  return merged;
}

/**
 * Meet не анимирует индикатор речи на плитке самого владельца записи, поэтому
 * в записи без раздельных каналов его реплики остаются без имени.
 * Если имя владельца известно, безымянная речь — его. Если нет, то в разговоре
 * ровно двоих она достаётся второму, но только если тот не проявлялся в логе.
 */
function guessSilentSpeaker(utterances, participants, { selfName, stereo }) {
  if (stereo) return utterances; // владельца уже узнали по каналу микрофона

  if (selfName) {
    return utterances.map((utterance) =>
      utterance.speaker ? utterance : { ...utterance, speaker: selfName },
    );
  }

  if (participants.length !== 2) return utterances;

  const heard = new Set(utterances.map((u) => u.speaker).filter(Boolean));
  if (heard.size !== 1) return utterances;

  const missing = participants.find((name) => !heard.has(name));
  if (!missing) return utterances;

  return utterances.map((utterance) =>
    utterance.speaker ? utterance : { ...utterance, speaker: missing },
  );
}

/**
 * @param {{start: number, end: number, text: string, words?: {start: number, end: number, text: string, channel?: string|null}[]}[]} segments
 *   сегменты Whisper, секунды; channel слова — 'mic', 'tab' или null
 * @param {{t: number, name: string|null}[]} speakerEvents смены активного говорящего, секунды
 * @param {string[]} participants состав встречи
 * @param {{selfName?: string|null}} options имя владельца записи, если Meet его выдал
 * @returns {{speaker: string|null, start: number, end: number, text: string}[]}
 */
export function attributeSpeakers(segments, speakerEvents, participants = [], { selfName = null } = {}) {
  const zones = toZones(speakerEvents);

  // В разговоре один на один голос из вкладки может принадлежать только второму.
  const remote = participants.filter((name) => name !== selfName);
  const context = {
    selfName,
    selfLabel: selfName ?? SELF_FALLBACK,
    onlyRemote: selfName && remote.length === 1 ? remote[0] : null,
  };

  // Имена расставляются по всему потоку слов сразу: начало реплики часто
  // оказывается в соседней фразе Whisper, а имя для него — в следующей.
  const words = segments.flatMap((segment) => segment.words ?? []);
  const labels = fillGaps(words, labelWords(words, zones, context));
  const labelOf = new Map(words.map((word, i) => [word, labels[i]]));

  const utterances = segments.flatMap((segment) =>
    splitBySpeaker(segment, zones, labelOf, context.selfLabel),
  );
  // Каналы есть, если хоть одно слово ими помечено (пусть и как неопределённое).
  const stereo = words.some((word) => 'channel' in word);
  return mergeConsecutive(guessSilentSpeaker(utterances, participants, { selfName, stereo }));
}
