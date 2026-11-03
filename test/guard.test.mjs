import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTrustedRequest } from '../server/guard.mjs';

const PORT = 8788;

test('расширение и открытый вручную адрес пускаются', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:8788', origin: 'chrome-extension://abcdef' }, PORT), true);
  assert.equal(isTrustedRequest({ host: '127.0.0.1:8788' }, PORT), true);
  assert.equal(isTrustedRequest({ host: 'localhost:8788', origin: 'http://localhost:8788' }, PORT), true);
});

test('посторонний сайт не может ни читать заметки, ни слать записи', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:8788', origin: 'https://evil.example' }, PORT), false);
  assert.equal(isTrustedRequest({ host: '127.0.0.1:8788', origin: 'null' }, PORT), false);
});

test('чужой Host отсекается: защита от DNS rebinding', () => {
  assert.equal(isTrustedRequest({ host: 'evil.example:8788' }, PORT), false);
  assert.equal(isTrustedRequest({}, PORT), false);
});
