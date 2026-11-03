/**
 * Выжимка встречи через Claude Code CLI в headless-режиме.
 * Идёт по подписке — отдельный API-ключ не нужен.
 */

import { spawn } from 'node:child_process';

import { formatTimecode } from './render.mjs';
import { SELF_FALLBACK } from './attribute.mjs';

/** Порог, после которого встреча разбирается по частям, а выжимки сводятся вторым проходом. */
const MAX_CHARS_PER_CHUNK = 40000;

/** Инструменты Claude Code в этой задаче не нужны: на вход текст, на выход JSON. */
const DISALLOWED_TOOLS = 'Bash Edit Write Read Glob Grep WebFetch WebSearch Task';

const SCHEMA = `{
  "title": "краткое название встречи (3-6 слов)",
  "summary": "2-4 предложения о чём была встреча",
  "decisions": [{"what": "что решили", "context": "почему так решили"}],
  "action_items": [{"assignee": "имя участника", "task": "что сделать", "due": "срок так, как он прозвучал (например «до среды»), или пустая строка", "quote": "дословная цитата из транскрипта"}],
  "open_questions": ["вопрос, оставшийся без ответа"],
  "risks": ["риск, прозвучавший на встрече"]
}`;

const RULES = `Правила:
- Отвечай ТОЛЬКО валидным JSON по схеме, без пояснений и без markdown-обёртки.
- Не придумывай ничего, чего нет в транскрипте. Пустой раздел — пустой массив.
- В action_items поле quote обязательно и должно быть дословной цитатой из транскрипта.
- В assignee ставь имя из списка участников. Если исполнитель не назван явно — пустая строка.
- Транскрипт распознан автоматически: имена и термины могут быть искажены, учитывай это.
- Пиши по-русски.
- Не используй длинное тире «—». Вместо него ставь запятую, двоеточие или обычный дефис.`;

/** Длинные тире выдают сгенерированный текст, поэтому меняем их на обычные дефисы. */
export function sanitizeSummary(value) {
  if (typeof value === 'string') return value.replace(/\s*[\u2014\u2013]\s*/g, ' - ').trim();
  if (Array.isArray(value)) return value.map(sanitizeSummary);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeSummary(v)]));
  return value;
}

/**
 * Достаёт JSON из ответа модели, даже если он обёрнут в ```json.
 * @param {string} answer
 */
export function extractJson(answer) {
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1);

  try {
    return JSON.parse(candidate.trim());
  } catch {
    throw new Error(`Не удалось разобрать JSON в ответе модели: ${answer.slice(0, 200)}`);
  }
}

/**
 * Режет транскрипт по границам реплик, чтобы кусок влезал в один запрос.
 * @param {{speaker: string|null, text: string}[]} utterances
 * @param {number} maxChars
 */
export function chunkUtterances(utterances, maxChars = MAX_CHARS_PER_CHUNK) {
  const chunks = [];
  let current = [];
  let size = 0;

  for (const utterance of utterances) {
    const length = utterance.text.length;
    if (current.length && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(utterance);
    size += length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function formatTranscript(utterances) {
  return utterances
    .map((u) => `[${formatTimecode(u.start)}] ${u.speaker ?? 'Неизвестный'}: ${u.text}`)
    .join('\n');
}

/** Запускает claude -p, отдавая длинный текст через stdin, а не через аргументы. */
export function askClaude(instruction, stdinText, model) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', instruction, '--output-format', 'json', '--model', model, '--disallowed-tools', DISALLOWED_TOOLS],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude завершился с кодом ${code}: ${stderr.slice(0, 500)}`));
      try {
        const envelope = JSON.parse(stdout);
        resolve(envelope.result ?? stdout);
      } catch {
        resolve(stdout);
      }
    });

    child.stdin.end(stdinText);
  });
}

/** Что модель должна знать о встрече помимо транскрипта. */
function participantsLine(meta) {
  return [
    meta.participants?.length ? `Участники: ${meta.participants.join(', ')}.` : '',
    meta.selfName
      ? `Запись вёл ${meta.selfName}, его реплики подписаны его именем.`
      : `Реплики с подписью «${SELF_FALLBACK}» принадлежат тому, кто вёл запись.`,
    meta.glossary?.length
      ? `Термины встречи в правильном написании: ${meta.glossary.join(', ')}. Если в транскрипте искажённая форма, пиши правильную.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {{speaker: string|null, start: number, text: string}[]} utterances
 * @param {{participants?: string[], title?: string, selfName?: string|null, glossary?: string[]}} meta
 * @param {{model?: string}} options
 */
export async function summarize(utterances, meta = {}, { model = 'claude-opus-5-5' } = {}) {
  const chunks = chunkUtterances(utterances);

  if (chunks.length === 1) {
    const instruction = `Ты делаешь протокол рабочей встречи по её транскрипту.
${participantsLine(meta)}
Верни JSON строго по схеме:
${SCHEMA}

${RULES}

Транскрипт придёт следующим сообщением.`;
    return sanitizeSummary(extractJson(await askClaude(instruction, formatTranscript(utterances), model)));
  }

  const partials = [];
  for (const [index, chunk] of chunks.entries()) {
    const instruction = `Это часть ${index + 1} из ${chunks.length} транскрипта рабочей встречи.
${participantsLine(meta)}
Разбери ТОЛЬКО эту часть и верни JSON строго по схеме:
${SCHEMA}

${RULES}

Транскрипт придёт следующим сообщением.`;
    partials.push(await askClaude(instruction, formatTranscript(chunk), model));
  }

  const mergeInstruction = `Ниже несколько JSON-выжимок последовательных частей одной встречи.
Сведи их в один итоговый JSON по той же схеме:
${SCHEMA}

${RULES}
- Объединяй дубли, сохраняй хронологию, ничего не выбрасывай.

Выжимки придут следующим сообщением.`;
  return sanitizeSummary(extractJson(await askClaude(mergeInstruction, partials.join('\n\n---\n\n'), model)));
}
