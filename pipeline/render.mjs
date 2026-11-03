/**
 * Сборка markdown-заметки из выжимки и транскрипта.
 * Чистая функция: никакого I/O, только строки.
 */

const UNKNOWN_SPEAKER = '?';

function formatDate(iso, timezone) {
  const date = new Date(iso);
  const options = { timeZone: timezone, day: 'numeric', month: 'long', year: 'numeric' };
  const day = new Intl.DateTimeFormat('ru-RU', options).format(date);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return `${day}, ${time}`;
}

/** Таймкод реплики: mm:ss, а для длинных встреч — h:mm:ss. */
export function formatTimecode(seconds) {
  const total = Math.floor(seconds);
  const s = String(total % 60).padStart(2, '0');
  const m = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** Длительность встречи человеческим языком: «40 сек», «32 мин», «1 ч 31 мин». */
function formatDuration(seconds) {
  if (!seconds) return null;
  if (seconds < 60) return `${Math.round(seconds)} сек`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;

  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

/** Секция попадает в заметку, только если ей есть что показать. */
function section(heading, lines) {
  return lines.length ? [`## ${heading}`, '', ...lines, ''] : [];
}

function renderDecisions(decisions = []) {
  return decisions.map((d) => (d.context ? `- **${d.what}**: ${d.context}` : `- **${d.what}**`));
}

function renderActionItems(items = []) {
  return items.flatMap((item) => {
    const assignee = item.assignee?.trim() || 'Не назначено';
    // Срок печатается как прозвучал («до среды», «к пятнице») — свой предлог не добавляем.
    const due = item.due?.trim() ? ` · ${item.due.trim()}` : '';
    const line = `- **${assignee}**: ${item.task}${due}`;
    return item.quote?.trim() ? [line, `  > «${item.quote.trim()}»`] : [line];
  });
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

/**
 * Разбор поведения владельца записи. Свёрнут: заметку показывают
 * на демонстрации экрана, а личный разбор там видеть не нужно.
 */
function renderReview(review) {
  if (!review?.stats) return [];
  const { stats, advice } = review;

  const fillers = stats.fillers.slice(0, 4).map((f) => `«${f.word}» ×${f.count}`).join(', ');
  const numbers = [
    `- **Доля эфира**: ${formatPercent(stats.share)} (${formatDuration(stats.selfSec)} из ${formatDuration(stats.totalSec)}), говорящих: ${stats.speakers}, ровная доля была бы ${formatPercent(1 / stats.speakers)}`,
    `- **Ходов**: ${stats.turns}, в среднем ${formatDuration(stats.avgTurnSec)}, самый длинный монолог ${formatDuration(stats.longest.sec)} на ${formatTimecode(stats.longest.start)}`,
    ...(stats.wpm ? [`- **Темп**: ${stats.wpm} слов/мин`] : []),
    `- **Вопросов задано**: ${stats.questions}`,
    `- **Начато поверх собеседника**: ${stats.interruptions}`,
    `- **Слова-паразиты**: ${stats.fillersPer100.toFixed(1)} на 100 слов${fillers ? ` (${fillers})` : ''}`,
  ];

  const quoted = (line, quote) => (quote?.trim() ? [line, `  > «${quote.trim()}»`] : [line]);
  const strengths = (advice?.strengths ?? []).flatMap((s) => quoted(`- ${s.point}`, s.quote));
  const improvements = (advice?.improvements ?? []).flatMap((item) => [
    ...quoted(`- **${item.issue}**`, item.quote),
    ...(item.tip?.trim() ? [`  - Как лучше: ${item.tip.trim()}`] : []),
  ]);

  return [
    '<details>',
    '<summary>Мой разбор: как я общаюсь</summary>',
    '',
    ...(advice?.verdict?.trim() ? [advice.verdict.trim(), ''] : []),
    '### В цифрах',
    '',
    ...numbers,
    '',
    ...(strengths.length ? ['### Что получается', '', ...strengths, ''] : []),
    ...(improvements.length ? ['### Что поправить', '', ...improvements, ''] : []),
    ...(advice?.practice?.trim() ? ['### На следующую встречу', '', advice.practice.trim(), ''] : []),
    '</details>',
    '',
  ];
}

function renderTranscript(utterances = []) {
  return utterances.map(
    (u) => `[${formatTimecode(u.start)}] **${u.speaker ?? UNKNOWN_SPEAKER}:** ${u.text}\n`,
  );
}

/**
 * @param {{meta: object, summary: object, utterances: object[], review?: {stats: object, advice: object|null}|null}} input
 * @returns {string} markdown
 */
export function renderNote({ meta, summary, utterances = [], review = null }) {
  // Название встречи из Meet точнее придуманного моделью: по нему заметку
  // потом и ищут. Тема от модели остаётся подзаголовком.
  const meetTitle = meta.title?.trim();
  const modelTitle = summary.title?.trim();
  const title = meetTitle || modelTitle || 'Встреча';
  const subtitle = meetTitle && modelTitle && modelTitle !== meetTitle ? modelTitle : null;
  const participants = meta.participants?.length ? meta.participants.join(', ') : null;

  const header = [
    `# ${title}`,
    '',
    [
      `**${formatDate(meta.startedAt, meta.timezone)}**`,
      formatDuration(meta.durationSec),
      participants,
    ]
      .filter(Boolean)
      .join(' · '),
    '',
    ...(subtitle ? [`*${subtitle}*`, ''] : []),
  ];

  const overview = summary.summary?.trim() ? [summary.summary.trim(), ''] : [];

  const body = [
    ...section('Решения', renderDecisions(summary.decisions)),
    ...section('Задачи', renderActionItems(summary.action_items)),
    ...section(
      'Открытые вопросы',
      (summary.open_questions ?? []).map((q) => `- ${q}`),
    ),
    ...section(
      'Риски',
      (summary.risks ?? []).map((r) => `- ${r}`),
    ),
  ];

  const transcript = utterances.length
    ? ['<details>', '<summary>Полный транскрипт</summary>', '', ...renderTranscript(utterances), '', '</details>', '']
    : [];

  const tail = [...renderReview(review), ...transcript];

  return [...header, ...overview, ...body, ...(tail.length ? ['---', '', ...tail] : [])].join('\n');
}
