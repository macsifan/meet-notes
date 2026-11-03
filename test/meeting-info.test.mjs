import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { pickTitle, collectTitleCandidates } from '../extension/meeting-info.js';

const CODE = 'abc-defg-hij';

test('название из панели встречи важнее заголовка вкладки', () => {
  const title = pickTitle({
    panel: ['Синк по релизу'],
    documentTitle: 'Denis / Oleg',
    meetingCode: CODE,
  });

  assert.equal(title, 'Синк по релизу');
});

test('без названия в панели берётся заголовок вкладки', () => {
  const title = pickTitle({ panel: [], documentTitle: 'Denis / Oleg', meetingCode: CODE });

  assert.equal(title, 'Denis / Oleg');
});

test('служебный заголовок вкладки не становится названием', () => {
  const title = pickTitle({ panel: [], documentTitle: 'Meet — abc-defg-hij', meetingCode: CODE });

  assert.equal(title, CODE);
});

test('код встречи не путается с названием, даже если попал в панель', () => {
  const title = pickTitle({ panel: [CODE], documentTitle: 'Синк по релизу', meetingCode: CODE });

  assert.equal(title, 'Синк по релизу');
});

test('когда ничего не найдено, названием остаётся код встречи', () => {
  const title = pickTitle({ panel: [], documentTitle: '', meetingCode: CODE });

  assert.equal(title, CODE);
});

test('название встречи вычитывается из разметки Meet', () => {
  const dom = new JSDOM(
    `<div data-meeting-title="Планёрка команды"></div>
     <div role="heading">Планёрка команды</div>`,
    { url: `https://meet.google.com/${CODE}` },
  );
  dom.window.document.title = 'Meet — Планёрка команды';

  const candidates = collectTitleCandidates(dom.window.document, dom.window.location);

  assert.equal(candidates.meetingCode, CODE);
  assert.ok(
    candidates.panel.includes('Планёрка команды'),
    `в кандидатах нет названия: ${JSON.stringify(candidates)}`,
  );
  assert.equal(pickTitle(candidates), 'Планёрка команды');
});

test('встреча один на один называется по участникам, без дублей из разметки', () => {
  const title = pickTitle({
    panel: ['Pavel / Oleg\nPavel / Oleg', 'Chat'],
    documentTitle: 'Meet – Pavel / Oleg',
    meetingCode: 'syp-jyxa-zzv',
  });

  assert.equal(title, 'Pavel / Oleg');
});

test('заголовок вкладки чистится от префикса Meet с любым тире', () => {
  const title = pickTitle({
    panel: [],
    documentTitle: 'Meet – Pavel / Oleg',
    meetingCode: 'syp-jyxa-zzv',
  });

  assert.equal(title, 'Pavel / Oleg');
});

test('длинные куски интерфейса не попадают в кандидаты', () => {
  const dom = new JSDOM(
    `<div role="heading">${'очень длинный текст '.repeat(20)}</div>`,
    { url: `https://meet.google.com/${CODE}` },
  );

  const candidates = collectTitleCandidates(dom.window.document, dom.window.location);

  assert.deepEqual(candidates.panel, []);
});
