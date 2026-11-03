/**
 * Разбор того, как владелец записи общался на встрече: цифры по транскрипту
 * и советы модели с цитатами из его же реплик.
 *
 * Цифры считаются здесь, а не моделью: доли эфира и счётчики модель
 * оценивает на глаз и ошибается. Модель получает их готовыми и опирается на них.
 */

import { normalizeWords } from './metrics.mjs';
import { askClaude, extractJson, formatTranscript, sanitizeSummary } from './summarize.mjs';

/**
 * Слова-паразиты в нормализованном виде. Whisper часто выбрасывает «э» и «мм»,
 * поэтому их счёт занижен, а словесные паразиты он сохраняет честно.
 */
const FILLERS = [
  'ну', 'вот', 'типа', 'как бы', 'короче', 'в общем', 'в принципе', 'это самое',
  'так сказать', 'на самом деле', 'собственно', 'получается', 'как его', 'скажем так',
  'э', 'ээ', 'эээ', 'мм', 'ммм',
];

/** Реплика начата раньше, чем собеседник закончил, с таким запасом: меньшее даёт неточность таймкодов. */
const INTERRUPT_OVERLAP_SEC = 0.5;

/** Меньше этого цифры и советы ничего не значат: человек почти не говорил. */
const MIN_SELF_WORDS = 40;

function countFillers(words) {
  const counts = new Map();
  for (const filler of FILLERS) {
    const phrase = filler.split(' ');
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((word, k) => words[i + k] === word)) counts.set(filler, (counts.get(filler) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([word, count]) => ({ word, count }));
}

/**
 * @param {{speaker: string|null, start: number, end: number, text: string}[]} utterances
 * @param {string} selfLabel подпись реплик владельца записи
 * @returns {null | {
 *   selfSec: number, totalSec: number, share: number, speakers: number,
 *   turns: number, avgTurnSec: number, longest: {sec: number, start: number},
 *   wpm: number|null, words: number, questions: number, interruptions: number,
 *   fillers: {word: string, count: number}[], fillersPer100: number
 * }} null, если владелец записи почти не говорил
 */
export function speakingStats(utterances, selfLabel) {
  // Подряд идущие реплики владельца склеиваются в один «ход»: мысль,
  // разрезанная на абзацы по длине, остаётся одним монологом.
  const turns = [];
  let previous = null;
  let interruptions = 0;
  for (const utterance of utterances) {
    const isSelf = utterance.speaker === selfLabel;
    if (isSelf && previous && previous.speaker !== selfLabel && utterance.start < previous.end - INTERRUPT_OVERLAP_SEC) {
      interruptions += 1;
    }
    if (isSelf) {
      const last = turns.at(-1);
      if (last && previous?.speaker === selfLabel) last.end = utterance.end;
      else turns.push({ start: utterance.start, end: utterance.end });
    }
    previous = utterance;
  }

  const own = utterances.filter((u) => u.speaker === selfLabel);
  const words = own.flatMap((u) => normalizeWords(u.text));
  if (words.length < MIN_SELF_WORDS) return null;

  const duration = (u) => Math.max(0, u.end - u.start);
  const selfSec = own.reduce((sum, u) => sum + duration(u), 0);
  const totalSec = utterances.reduce((sum, u) => sum + duration(u), 0);
  const longest = turns.reduce((best, t) => (t.end - t.start > best.sec ? { sec: t.end - t.start, start: t.start } : best), {
    sec: 0,
    start: 0,
  });
  const fillers = countFillers(words);
  const fillerTotal = fillers.reduce((sum, f) => sum + f.count, 0);

  return {
    selfSec,
    totalSec,
    share: totalSec ? selfSec / totalSec : 0,
    // Безымянная речь тоже чья-то: считаем её одним собеседником.
    speakers: new Set(utterances.map((u) => u.speaker ?? '?')).size,
    turns: turns.length,
    avgTurnSec: turns.length ? selfSec / turns.length : 0,
    longest,
    wpm: selfSec >= 30 ? Math.round(words.length / (selfSec / 60)) : null,
    words: words.length,
    questions: own.reduce((sum, u) => sum + (u.text.match(/\?/g)?.length ?? 0), 0),
    interruptions,
    fillers,
    fillersPer100: (fillerTotal / words.length) * 100,
  };
}

const SCHEMA = `{
  "verdict": "1-2 предложения: какое впечатление производит собеседник со стороны",
  "strengths": [{"point": "что получается хорошо", "quote": "дословная цитата реплики участника"}],
  "improvements": [{"issue": "что мешает быть понятным или приятным собеседником", "quote": "дословная цитата реплики участника", "tip": "как сказать или сделать иначе, конкретно"}],
  "practice": "одно простое упражнение на следующую встречу"
}`;

function formatStats(stats) {
  const fillers = stats.fillers.slice(0, 5).map((f) => `${f.word} ×${f.count}`).join(', ') || 'нет';
  return [
    `Доля эфира: ${Math.round(stats.share * 100)}% при ${stats.speakers} говорящих`,
    `Ходов: ${stats.turns}, в среднем ${Math.round(stats.avgTurnSec)} с, самый длинный ${Math.round(stats.longest.sec)} с`,
    `Темп: ${stats.wpm ?? 'неизвестно'} слов/мин`,
    `Вопросов задано: ${stats.questions}`,
    `Реплик, начатых до того, как собеседник договорил: ${stats.interruptions}`,
    `Слова-паразиты: ${stats.fillersPer100.toFixed(1)} на 100 слов (${fillers})`,
  ].join('\n');
}

/**
 * @param {{speaker: string|null, start: number, end: number, text: string}[]} utterances
 * @param {string} selfLabel
 * @param {object} stats результат speakingStats
 * @param {{model?: string}} options
 */
export async function adviseSpeaker(utterances, selfLabel, stats, { model = 'claude-opus-5-5' } = {}) {
  const instruction = `Ты коуч по деловой коммуникации. Ниже транскрипт рабочей встречи.
Разбери, как в ней общался участник «${selfLabel}»: насколько понятно формулируются мысли,
слушает ли собеседников, даёт ли им договорить, задаёт ли вопросы, не затягивает ли монологи,
доводит ли разговор до ясных договорённостей. Участник хочет стать хорошим и понятным собеседником.

Цифры по транскрипту, они посчитаны точно:
${formatStats(stats)}

Верни JSON строго по схеме:
${SCHEMA}

Правила:
- Отвечай ТОЛЬКО валидным JSON по схеме, без пояснений и без markdown-обёртки.
- Разбирай только реплики «${selfLabel}», остальных участников не оценивай.
- Каждое наблюдение подкрепляй дословной цитатой реплики этого участника из транскрипта.
- strengths: 1-3 пункта, improvements: 2-4 самых важных пункта, без мелочей.
- Совет в tip должен быть выполним на следующей же встрече: формулировка, приём, привычка.
- Транскрипт распознан автоматически: оговорки и обрывки фраз могут быть ошибкой распознавания,
  а подписи говорящих иногда путаются. Не делай выводов из одного сомнительного места.
- Обращайся к участнику на «ты», советы давай в повелительном наклонении.
- Пиши по-русски.
- Не используй длинное тире «—». Вместо него ставь запятую, двоеточие или обычный дефис.

Транскрипт придёт следующим сообщением.`;

  return sanitizeSummary(extractJson(await askClaude(instruction, formatTranscript(utterances), model)));
}
