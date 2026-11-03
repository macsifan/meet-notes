/**
 * Метрики качества транскрипта против вычитанного вручную эталона.
 *
 * - WER: доля ошибок в словах (замены + пропуски + вставки) / слов в эталоне;
 * - словарь: сколько упоминаний терминов и имён из эталона распознано верно;
 * - говорящие: у какой доли совпавших слов подпись та же, что в эталоне.
 */

/** Сравнение без регистра, пунктуации и разницы «е/ё», дефис делит слово. */
export function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Разбор текста в формате «Имя: реплика» построчно. Строки с # — комментарии.
 * Подпись «?» означает, что говорящий неизвестен.
 * @returns {{speaker: string|null, word: string}[]}
 */
export function parseTranscript(text) {
  const words = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*([^:]{1,60}):\s+(.*)$/);
    const speaker = match ? match[1].trim() : null;
    const body = match ? match[2] : line;
    for (const word of normalizeWords(body)) {
      words.push({ speaker: speaker === '?' ? null : speaker, word });
    }
  }
  return words;
}

/**
 * Выравнивание по Левенштейну с обратным ходом.
 * @param {string[]} reference
 * @param {string[]} hypothesis
 * @returns {{errors: number, pairs: [number, number][]}} pairs — совпавшие позиции
 */
export function alignWords(reference, hypothesis) {
  const n = reference.length;
  const m = hypothesis.length;
  const cost = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) cost[i][0] = i;
  for (let j = 0; j <= m; j++) cost[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const substitution = cost[i - 1][j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      cost[i][j] = Math.min(substitution, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }

  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const same = reference[i - 1] === hypothesis[j - 1];
    if (cost[i][j] === cost[i - 1][j - 1] + (same ? 0 : 1)) {
      if (same) pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (cost[i][j] === cost[i - 1][j] + 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  return { errors: cost[n][m], pairs: pairs.reverse() };
}

function countPhrase(words, phrase) {
  let count = 0;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phrase.every((word, k) => words[i + k] === word)) count += 1;
  }
  return count;
}

/**
 * @param {{speaker: string|null, word: string}[]} reference
 * @param {{speaker: string|null, word: string}[]} hypothesis
 * @param {string[]} vocabulary термины и имена, правильность которых важна отдельно
 */
export function scoreTranscript(reference, hypothesis, vocabulary = []) {
  const refWords = reference.map((w) => w.word);
  const hypWords = hypothesis.map((w) => w.word);
  const { errors, pairs } = alignWords(refWords, hypWords);

  let expected = 0;
  let found = 0;
  const missed = [];
  for (const term of vocabulary) {
    const phrase = normalizeWords(term);
    if (!phrase.length) continue;
    const inReference = countPhrase(refWords, phrase);
    if (!inReference) continue;
    const recognized = Math.min(inReference, countPhrase(hypWords, phrase));
    expected += inReference;
    found += recognized;
    if (recognized < inReference) missed.push(term);
  }

  const labelled = pairs.filter(([r]) => reference[r].speaker);
  const sameSpeaker = labelled.filter(([r, h]) => reference[r].speaker === hypothesis[h].speaker);
  const unlabelled = hypothesis.filter((w) => !w.speaker).length;

  return {
    words: refWords.length,
    wer: refWords.length ? errors / refWords.length : 0,
    vocabulary: { expected, found, recall: expected ? found / expected : null, missed },
    speakers: {
      checked: labelled.length,
      accuracy: labelled.length ? sameSpeaker.length / labelled.length : null,
      unlabelledShare: hypothesis.length ? unlabelled / hypothesis.length : 0,
    },
  };
}
