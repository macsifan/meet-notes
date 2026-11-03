import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGlossary, buildWhisperPrompt } from '../pipeline/vocabulary.mjs';

test('глоссарий читается по строке на термин, комментарии и дубли отбрасываются', () => {
  const text = '# термины команды\nАБ-тест\n\nMDE  # minimum detectable effect\nConfluence\nАБ-тест\n';

  assert.deepEqual(parseGlossary(text), ['АБ-тест', 'MDE', 'Confluence']);
});

test('подсказка Whisper содержит название, термины и участников', () => {
  const prompt = buildWhisperPrompt({
    title: 'Автоматизация АБ-тестов',
    participants: ['Irina Kozlova', 'Pavel Lebedev'],
    glossary: ['АБ-тест', 'MDE'],
  });

  assert.equal(
    prompt,
    'Встреча «Автоматизация АБ-тестов». Термины: АБ-тест, MDE. Участники: Irina Kozlova, Pavel Lebedev.',
  );
});

test('длинный глоссарий урезается, а имена участников остаются целиком', () => {
  // Whisper отбрасывает начало слишком длинной подсказки, поэтому длину
  // контролируем сами и жертвуем терминами, а не именами.
  const glossary = Array.from({ length: 200 }, (_, i) => `термин${i}`);
  const participants = ['Elena Volkova', 'Roman Novikov'];

  const prompt = buildWhisperPrompt({ participants, glossary });

  assert.ok(prompt.length <= 450, `длина ${prompt.length}`);
  assert.ok(prompt.endsWith('Участники: Elena Volkova, Roman Novikov.'));
  assert.match(prompt, /термин0, термин1/);
});

test('без словаря подсказка пустая', () => {
  assert.equal(buildWhisperPrompt({}), '');
});
