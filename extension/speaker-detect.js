/**
 * Определение активного говорящего в Google Meet.
 *
 * Классы в вёрстке Meet обфусцированы и меняются, поэтому детект не привязан
 * к ним: у говорящего анимируется индикатор речи, и его плитка генерирует
 * заметно больше DOM-мутаций, чем молчащие. Считаем мутации по плиткам
 * в коротком окне и берём лидера.
 *
 * Единственная привязка к разметке — SELECTORS ниже; при переезде Meet
 * чинится правка одного объекта (см. dumpTiles для калибровки).
 */

import { readableText } from './text-utils.js';
import { parseParticipantName } from './participant-name.js';

export const SELECTORS = {
  tile: '[data-participant-id]',
  selfName: '[data-self-name]',
  chatInput: 'textarea[aria-label], div[contenteditable="true"][aria-label]',
};

/** Подписи, которые Meet рисует рядом с именем — в имя они попадать не должны. */
const SERVICE_LABELS = /^(презентация|показ|presenting|you|вы|выключен|muted)$/i;

/**
 * Плитки демонстрации экрана и интерфейсные сообщения Meet.
 * Плитка презентации «дрожит» от смены кадров, а не от речи —
 * считать её говорящим участником нельзя.
 */
const NOT_A_PERSON = /\((your |ваша )?(presentation|презентация)\)|might still see|продолжают видеть/i;

/** Имя человека — не предложение: без точки на конце и не длиннее пяти слов. */
function looksLikeSentence(text) {
  return /[.!?]$/.test(text) || text.split(/\s+/).length > 5;
}

/**
 * Имена material-иконок вроде «frame_person» или «mic_off»: Meet рендерит их
 * текстом внутри плитки, и без фильтра они попадают в список участников.
 */
const ICON_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Кто говорил в последнем окне наблюдения.
 * @param {Map<string, number>} activity число мутаций на участника
 * @param {number} threshold ниже него считаем, что все молчат
 * @returns {string|null}
 */
export function pickActive(activity, threshold) {
  let leader = null;
  let best = 0;

  for (const [name, count] of activity) {
    if (count > best) {
      leader = name;
      best = count;
    }
  }
  return best >= threshold ? leader : null;
}

/**
 * Добавляет событие только если говорящий действительно сменился:
 * лог должен описывать переходы, а не тикать каждое окно.
 * @param {{t: number, name: string|null}[]} events
 * @param {number} t секунды от начала записи
 * @param {string|null} name
 */
export function appendSpeakerEvent(events, t, name) {
  const previous = events.at(-1);
  if (previous ? previous.name === name : name === null) return events;

  events.push({ t: Number(t.toFixed(2)), name });
  return events;
}

function isUsableName(name) {
  return Boolean(
    name &&
      name.length <= 60 &&
      !SERVICE_LABELS.test(name) &&
      !ICON_NAME.test(name) &&
      !NOT_A_PERSON.test(name) &&
      !looksLikeSentence(name),
  );
}

/**
 * Имя и признак «это я» для плитки. Подпись прогоняется через разбор:
 * Meet склеивает с именем метку «(You)», роль и имена иконок.
 * @returns {{name: string, isSelf: boolean}|null}
 */
function tileIdentity(tile) {
  const selfLabel = tile.querySelector(SELECTORS.selfName);
  const candidates = [
    readableText(selfLabel?.textContent),
    // innerText учитывает переносы строк вёрстки, textContent — запасной путь.
    readableText(tile.innerText ?? tile.textContent),
    // У участника без видео в плитке нарисована иконка, а имя остаётся в подписи.
    readableText(tile.getAttribute('aria-label')),
  ];

  for (const raw of candidates) {
    const parsed = parseParticipantName(raw);
    if (parsed && isUsableName(parsed.name)) {
      return { name: parsed.name, isSelf: parsed.isSelf || Boolean(selfLabel) };
    }
  }
  return null;
}

function tileName(tile) {
  return tileIdentity(tile)?.name ?? null;
}

/**
 * Следит за встречей и копит лог говорящих.
 * @param {{root?: Document|Element, windowMs?: number, threshold?: number}} options
 */
export function createTracker({
  root = document,
  windowMs = 300,
  threshold = 4,
  stableWindows = 3,
} = {}) {
  const speakerEvents = [];
  const participants = new Set();
  let selfName = null;
  let activity = new Map();
  let observer = null;
  let timer = null;
  let startedAt = 0;
  let pendingName;
  let pendingCount = 0;
  let pendingSince = 0;

  function bump(node) {
    // nodeType вместо instanceof Element: наблюдаемый документ может быть чужим.
    const element = node.nodeType === 1 ? node : node.parentElement;
    const tile = element?.closest(SELECTORS.tile);
    if (!tile) return;

    const identity = tileIdentity(tile);
    if (!identity) return;

    const { name } = identity;
    remember(identity);
    activity.set(name, (activity.get(name) ?? 0) + 1);
  }

  function remember({ name, isSelf }) {
    participants.add(name);
    if (isSelf && !selfName) selfName = name;
  }

  /**
   * Смена говорящего фиксируется, только если кандидат продержался несколько
   * окон подряд. Без этого лог дробится на тысячи мгновенных переключений:
   * анимация в Meet дрожит неравномерно, и лидер меняется почти в каждом окне.
   */
  function tick() {
    const seconds = (Date.now() - startedAt) / 1000;
    const candidate = pickActive(activity, threshold);
    activity = new Map();

    const current = speakerEvents.at(-1)?.name ?? null;
    if (candidate === current) {
      pendingName = undefined;
      pendingCount = 0;
      return;
    }

    if (candidate === pendingName) {
      pendingCount += 1;
    } else {
      pendingName = candidate;
      pendingCount = 1;
      pendingSince = seconds; // время первого появления, а не подтверждения
    }

    if (pendingCount >= stableWindows) {
      appendSpeakerEvent(speakerEvents, pendingSince, candidate);
      pendingName = undefined;
      pendingCount = 0;
    }
  }

  /** Наблюдатель берётся из окна самого документа, а не из глобала. */
  function observerClass() {
    const view = root.defaultView ?? root.ownerDocument?.defaultView;
    return view?.MutationObserver ?? globalThis.MutationObserver;
  }

  return {
    start() {
      startedAt = Date.now();
      const Observer = observerClass();
      observer = new Observer((mutations) => {
        for (const mutation of mutations) bump(mutation.target);
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
      timer = setInterval(tick, windowMs);

      // Сразу фиксируем состав встречи, даже если все молчат.
      for (const tile of root.querySelectorAll(SELECTORS.tile)) {
        const identity = tileIdentity(tile);
        if (identity) remember(identity);
      }
    },

    stop() {
      observer?.disconnect();
      clearInterval(timer);
      observer = null;
      timer = null;
    },

    getLog() {
      return { speakerEvents: [...speakerEvents], participants: [...participants], selfName };
    },

    /** Для калибровки селекторов после очередного обновления Meet. */
    dumpTiles() {
      return [...root.querySelectorAll(SELECTORS.tile)].map((tile) => ({
        id: tile.getAttribute('data-participant-id'),
        name: tileName(tile),
        text: (tile.textContent ?? '').slice(0, 120),
      }));
    },
  };
}
