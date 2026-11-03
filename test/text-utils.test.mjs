import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readableText } from '../extension/text-utils.js';

test('имя, продублированное через перенос строки, берётся один раз', () => {
  assert.equal(readableText('Oleg Sokolov\nOleg Sokolov'), 'Oleg Sokolov');
});

test('имя, склеенное само с собой без разделителя, распознаётся как повтор', () => {
  assert.equal(readableText('Oleg SokolovOleg Sokolov'), 'Oleg Sokolov');
});

test('название встречи с повтором очищается', () => {
  assert.equal(readableText('Pavel / Oleg\nPavel / Oleg'), 'Pavel / Oleg');
});

test('обычный текст остаётся нетронутым', () => {
  assert.equal(readableText('Синк по релизу'), 'Синк по релизу');
});

test('пустая строка и пробелы дают пустой результат', () => {
  assert.equal(readableText('   \n  '), '');
  assert.equal(readableText(null), '');
});

test('случайное совпадение половин не считается повтором', () => {
  assert.equal(readableText('Иван Иванов'), 'Иван Иванов');
});
