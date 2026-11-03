import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attributeSpeakers } from '../pipeline/attribute.mjs';

test('сегмент внутри зоны одного спикера получает его имя', () => {
  const segments = [{ start: 5, end: 8, text: 'Давайте начнём.' }];
  const speakerEvents = [{ t: 0, name: 'Иван' }];

  const utterances = attributeSpeakers(segments, speakerEvents);

  assert.deepEqual(utterances, [
    { speaker: 'Иван', start: 5, end: 8, text: 'Давайте начнём.' },
  ]);
});

test('в разговоре вдвоём безымянные реплики достаются второму участнику', () => {
  // Meet не анимирует индикатор на своей же плитке, поэтому речь владельца
  // записи детект не видит — но в разговоре двоих её больше некому принадлежать.
  const segments = [
    { start: 0, end: 5, text: 'Первая.' },
    { start: 5, end: 10, text: 'Вторая.' },
  ];
  const speakerEvents = [
    { t: 0, name: 'Elena Volkova' },
    { t: 5, name: null },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents, [
    'Elena Volkova',
    'Oleg Sokolov',
  ]);

  assert.deepEqual(
    utterances.map((u) => u.speaker),
    ['Elena Volkova', 'Oleg Sokolov'],
  );
});

test('когда участников больше двух, безымянные реплики не угадываются', () => {
  const segments = [{ start: 5, end: 10, text: 'Реплика.' }];
  const speakerEvents = [{ t: 0, name: 'Иван' }, { t: 5, name: null }];

  const [utterance] = attributeSpeakers(segments, speakerEvents, ['Иван', 'Мария', 'Пётр']);

  assert.equal(utterance.speaker, null);
});

test('если говорили оба, ничего не додумывается', () => {
  const segments = [
    { start: 0, end: 5, text: 'Первая.' },
    { start: 5, end: 10, text: 'Вторая.' },
    { start: 10, end: 15, text: 'Третья.' },
  ];
  const speakerEvents = [
    { t: 0, name: 'Иван' },
    { t: 5, name: 'Мария' },
    { t: 10, name: null },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents, ['Иван', 'Мария']);

  assert.deepEqual(
    utterances.map((u) => u.speaker),
    ['Иван', 'Мария', null],
  );
});

test('мусорное имя из разметки Meet не становится говорящим', () => {
  const segments = [{ start: 0, end: 5, text: 'Реплика.' }];
  // frame_person — имя иконки, которое Meet рисует текстом в плитке без видео.
  const speakerEvents = [{ t: 0, name: 'frame_person' }];

  const [utterance] = attributeSpeakers(segments, speakerEvents);

  assert.equal(utterance.speaker, null);
});

test('настоящее имя рядом с мусорным не теряется', () => {
  const segments = [
    { start: 0, end: 5, text: 'Первая.' },
    { start: 5, end: 10, text: 'Вторая.' },
  ];
  const speakerEvents = [
    { t: 0, name: 'frame_person' },
    { t: 5, name: 'Oleg Sokolov' },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents);

  assert.deepEqual(
    utterances.map((u) => u.speaker),
    [null, 'Oleg Sokolov'],
  );
});

test('сегмент на границе зон отдаётся спикеру с большим перекрытием', () => {
  const segments = [{ start: 10, end: 20, text: 'Я возьму на себя интеграцию.' }];
  const speakerEvents = [
    { t: 0, name: 'Иван' },
    { t: 12, name: 'Мария' },
  ];

  const [utterance] = attributeSpeakers(segments, speakerEvents);

  assert.equal(utterance.speaker, 'Мария');
});

test('паузы без говорящего не перебивают именованного спикера', () => {
  const segments = [{ start: 0, end: 20, text: 'Долгая реплика с паузами.' }];
  const speakerEvents = [
    { t: 0, name: null },
    { t: 5, name: 'Иван' },
    { t: 6, name: null },
  ];

  const [utterance] = attributeSpeakers(segments, speakerEvents);

  assert.equal(utterance.speaker, 'Иван');
});

test('без лога говорящих спикер остаётся неизвестным', () => {
  const segments = [{ start: 0, end: 3, text: 'Всем привет.' }];

  const [utterance] = attributeSpeakers(segments, []);

  assert.equal(utterance.speaker, null);
});

test('подряд идущие сегменты одного спикера склеиваются в одну реплику', () => {
  const segments = [
    { start: 0, end: 3, text: 'Давайте начнём.' },
    { start: 3, end: 6, text: 'Первый вопрос — сроки.' },
  ];
  const speakerEvents = [{ t: 0, name: 'Иван' }];

  const utterances = attributeSpeakers(segments, speakerEvents);

  assert.deepEqual(utterances, [
    { speaker: 'Иван', start: 0, end: 6, text: 'Давайте начнём. Первый вопрос — сроки.' },
  ]);
});

test('безымянный транскрипт режется на абзацы, а не слипается в простыню', () => {
  // Час речи без лога говорящих не должен превращаться в три гигантских блока.
  const segments = Array.from({ length: 40 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9,
    text: 'а'.repeat(100),
  }));

  const utterances = attributeSpeakers(segments, []);

  assert.ok(utterances.length >= 4, `получилось ${utterances.length} блоков`);
  assert.ok(
    utterances.every((u) => u.text.length <= 1200),
    'каждый абзац должен быть обозримым',
  );
});

test('длинная пауза разрывает реплику даже у одного спикера', () => {
  // Без этого транскрипт встречи без лога говорящих схлопывается
  // в один нечитаемый абзац на весь час.
  const segments = [
    { start: 0, end: 5, text: 'До паузы.' },
    { start: 35, end: 40, text: 'После паузы.' },
  ];

  const utterances = attributeSpeakers(segments, []);

  assert.equal(utterances.length, 2);
});

test('короткая пауза внутри речи не разрывает реплику', () => {
  const segments = [
    { start: 0, end: 5, text: 'Первая часть.' },
    { start: 8, end: 12, text: 'вторая часть.' },
  ];
  const speakerEvents = [{ t: 0, name: 'Иван' }];

  const utterances = attributeSpeakers(segments, speakerEvents);

  assert.equal(utterances.length, 1);
});

test('смена спикера разрывает реплику', () => {
  const segments = [
    { start: 0, end: 3, text: 'Кто возьмёт интеграцию?' },
    { start: 3, end: 6, text: 'Я возьму.' },
  ];
  const speakerEvents = [
    { t: 0, name: 'Иван' },
    { t: 3, name: 'Мария' },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents);

  assert.equal(utterances.length, 2);
  assert.deepEqual(
    utterances.map((u) => u.speaker),
    ['Иван', 'Мария'],
  );
});

test('речь до первого события лога остаётся без спикера', () => {
  const segments = [{ start: 0, end: 5, text: 'Слышно меня?' }];
  const speakerEvents = [{ t: 10, name: 'Иван' }];

  const [utterance] = attributeSpeakers(segments, speakerEvents);

  assert.equal(utterance.speaker, null);
});

/** Сегмент со словами: [текст, начало, конец, канал]. Без канала — моно-запись. */
function spoken(words) {
  const list = words.map(([text, start, end, channel]) =>
    channel === undefined ? { text, start, end } : { text, start, end, channel },
  );
  return {
    start: list[0].start,
    end: list.at(-1).end,
    text: list.map((w) => w.text).join(' '),
    words: list,
  };
}

test('фразы одного сегмента Whisper подписываются по логу Meet каждая своим автором', () => {
  // Вопрос и ответ Whisper отдал подряд, точка между ними разделяет авторов.
  const segments = [
    spoken([['Кто', 0, 0.5], ['возьмёт', 0.5, 1], ['интеграцию?', 1, 2]]),
    spoken([['Я', 3, 3.3], ['возьму', 3.3, 3.8], ['до', 3.8, 4], ['пятницы.', 4, 4.8]]),
  ];
  const speakerEvents = [
    { t: 0, name: 'Иван' },
    { t: 2.9, name: 'Мария' },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents);

  assert.deepEqual(
    utterances.map((u) => [u.speaker, u.text]),
    [
      ['Иван', 'Кто возьмёт интеграцию?'],
      ['Мария', 'Я возьму до пятницы.'],
    ],
  );
});

test('запоздавший лог Meet не рвёт фразу посередине', () => {
  // Лог переключился на Марию за два слова до конца фразы Ивана.
  const segment = spoken([
    ['Остальные', 0, 0.5],
    ['тесты', 0.5, 1],
    ['требуют', 1, 1.5],
    ['определённой', 1.5, 2.2],
    ['работы.', 2.2, 2.8],
  ]);
  const speakerEvents = [
    { t: 0, name: 'Иван' },
    { t: 1.6, name: 'Мария' },
  ];

  const utterances = attributeSpeakers([segment], speakerEvents);

  assert.deepEqual(
    utterances.map((u) => [u.speaker, u.text]),
    [['Иван', 'Остальные тесты требуют определённой работы.']],
  );
});

test('слова из канала микрофона принадлежат владельцу записи без всякого лога', () => {
  const segment = spoken([
    ['Ребята,', 0, 0.5, 'mic'],
    ['всем', 0.5, 0.8, 'mic'],
    ['привет.', 0.8, 1.2, 'mic'],
  ]);

  const [utterance] = attributeSpeakers([segment], [], ['Oleg Sokolov', 'Иван', 'Мария'], {
    selfName: 'Oleg Sokolov',
  });

  assert.equal(utterance.speaker, 'Oleg Sokolov');
});

test('без имени владельца его реплики подписываются «Я», а не остаются безымянными', () => {
  const segment = spoken([['Привет.', 0, 1, 'mic']]);

  const [utterance] = attributeSpeakers([segment], []);

  assert.equal(utterance.speaker, 'Я');
});

test('голос из вкладки не отдаётся владельцу, даже если лог Meet показал его плитку', () => {
  const segment = spoken([
    ['Согласна', 0, 0.6, 'tab'],
    ['с', 0.6, 0.7, 'tab'],
    ['этим.', 0.7, 1.2, 'tab'],
  ]);
  const speakerEvents = [{ t: 0, name: 'Oleg Sokolov' }];

  const [utterance] = attributeSpeakers([segment], speakerEvents, ['Oleg Sokolov', 'Иван', 'Мария'], {
    selfName: 'Oleg Sokolov',
  });

  assert.equal(utterance.speaker, null);
});

test('в разговоре один на один голос из вкладки принадлежит собеседнику', () => {
  const segment = spoken([
    ['Как', 0, 0.3, 'mic'],
    ['дела?', 0.3, 0.8, 'mic'],
    ['Нормально,', 1, 1.6, 'tab'],
    ['спасибо.', 1.6, 2.2, 'tab'],
  ]);

  const utterances = attributeSpeakers([segment], [], ['Artem Zaitsev', 'Oleg Sokolov'], {
    selfName: 'Oleg Sokolov',
  });

  assert.deepEqual(
    utterances.map((u) => [u.speaker, u.text]),
    [
      ['Oleg Sokolov', 'Как дела?'],
      ['Artem Zaitsev', 'Нормально, спасибо.'],
    ],
  );
});

test('мгновенное переключение в логе Meet не отрезает слово от фразы', () => {
  // Детект на долю секунды увидел Марию посреди фразы Ивана — это дрожание.
  const segment = spoken([
    ['Давайте', 0, 0.5],
    ['обсудим', 0.5, 1],
    ['сроки', 1, 1.5],
    ['релиза', 1.5, 2],
    ['сегодня.', 2, 2.6],
  ]);
  const speakerEvents = [
    { t: 0, name: 'Иван' },
    { t: 1, name: 'Мария' },
    { t: 1.4, name: 'Иван' },
  ];

  const utterances = attributeSpeakers([segment], speakerEvents);

  assert.deepEqual(
    utterances.map((u) => [u.speaker, u.text]),
    [['Иван', 'Давайте обсудим сроки релиза сегодня.']],
  );
});

test('короткая реплика из вкладки не приклеивается к владельцу записи', () => {
  const segment = spoken([
    ['Готово?', 0, 0.6, 'mic'],
    ['Да.', 1, 1.3, 'tab'],
  ]);
  const speakerEvents = [{ t: 0.9, name: 'Мария' }];

  const utterances = attributeSpeakers([segment], speakerEvents, [], { selfName: 'Oleg Sokolov' });

  assert.deepEqual(
    utterances.map((u) => u.speaker),
    ['Oleg Sokolov', 'Мария'],
  );
});

test('начало реплики собеседника в паузе лога достаётся ему, а не предыдущему', () => {
  // Meet подсвечивает плитку с опозданием: «Поняла.» звучит, пока лог ещё пуст,
  // а имя Камиллы появляется только к следующей фразе.
  const segments = [
    spoken([['Чтобы', 10, 10.5, 'tab'], ['чище.', 10.5, 11, 'tab']]),
    spoken([['Поняла.', 11.8, 12.3, 'tab']]),
    spoken([['А', 12.4, 12.5, 'tab'], ['SRM', 12.5, 13, 'tab'], ['проверяете?', 13, 13.8, 'tab']]),
  ];
  const speakerEvents = [
    { t: 9.8, name: 'Pavel Lebedev' },
    { t: 11.2, name: null },
    { t: 12.3, name: 'Irina Kozlova' },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents, [], { selfName: 'Oleg Sokolov' });

  assert.deepEqual(
    utterances.map((u) => [u.speaker, u.text]),
    [
      ['Pavel Lebedev', 'Чтобы чище.'],
      ['Irina Kozlova', 'Поняла. А SRM проверяете?'],
    ],
  );
});

test('в моно-записи безымянная речь принадлежит владельцу, если его имя известно', () => {
  // Свою плитку Meet не подсвечивает, поэтому владелец в логе молчит всегда.
  const segments = [
    spoken([['Всем', 0, 0.4], ['привет.', 0.4, 1]]),
    spoken([['Можно', 4, 4.4], ['уточнить?', 4.4, 5]]),
    spoken([['Давай.', 9, 9.6]]),
  ];
  const speakerEvents = [
    { t: 3.9, name: 'Irina Kozlova' },
    { t: 5.5, name: null },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents, ['Irina Kozlova', 'Pavel Lebedev', 'Oleg Sokolov'], {
    selfName: 'Oleg Sokolov',
  });

  assert.deepEqual(
    utterances.map((u) => u.speaker),
    ['Oleg Sokolov', 'Irina Kozlova', 'Oleg Sokolov'],
  );
});

test('в моно-записи пауза лога заполняется соседом только в пределах запаздывания Meet', () => {
  const segments = [
    spoken([['Поняла.', 10, 10.6]]), // за 0.4 с до подсветки Марии
    spoken([['Хорошо,', 11, 11.5], ['давайте.', 11.5, 12]]),
    spoken([['Тогда', 20, 20.5], ['я', 20.5, 20.7], ['начну.', 20.7, 21.2]]), // далеко от любого имени
  ];
  const speakerEvents = [
    { t: 11, name: 'Мария' },
    { t: 12.2, name: null },
  ];

  const utterances = attributeSpeakers(segments, speakerEvents, ['Иван', 'Мария', 'Пётр']);

  assert.deepEqual(
    utterances.map((u) => [u.speaker, u.text]),
    [
      ['Мария', 'Поняла. Хорошо, давайте.'],
      [null, 'Тогда я начну.'],
    ],
  );
});
