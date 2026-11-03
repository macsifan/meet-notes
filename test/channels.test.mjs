import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { channelEnergy, dominantChannel } from '../pipeline/channels.mjs';

/** Стерео PCM s16le 16 кГц: функции дают амплитуду каждого канала по времени. */
function stereoPcm(seconds, leftAt, rightAt) {
  const samples = Math.round(seconds * 16000);
  const buffer = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const t = i / 16000;
    const tone = Math.sin(2 * Math.PI * 220 * t);
    buffer.writeInt16LE(Math.round(tone * leftAt(t) * 32767), i * 4);
    buffer.writeInt16LE(Math.round(tone * rightAt(t) * 32767), i * 4 + 2);
  }
  return buffer;
}

test('громкость каналов считается по кадрам и указывает, кто говорит', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meet-notes-test-'));
  const rawPath = path.join(dir, 'stereo.raw');
  // Первая секунда — микрофон (левый), вторая — вкладка (правый) с тихим
  // эхом в микрофоне, третья — тишина.
  await writeFile(
    rawPath,
    stereoPcm(
      3,
      (t) => (t < 1 ? 0.3 : t < 2 ? 0.01 : 0),
      (t) => (t >= 1 && t < 2 ? 0.3 : 0),
    ),
  );

  try {
    const energy = await channelEnergy(rawPath);

    assert.equal(energy.left.length, 150);
    assert.equal(dominantChannel(energy, 0.1, 0.6), 'left');
    assert.equal(dominantChannel(energy, 1.2, 1.7), 'right');
    assert.equal(dominantChannel(energy, 2.2, 2.8), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('когда оба канала звучат одинаково, канал не угадывается', () => {
  const energy = {
    frameSec: 0.02,
    left: new Float32Array(50).fill(0.01),
    right: new Float32Array(50).fill(0.012),
  };

  assert.equal(dominantChannel(energy, 0, 1), null);
});

test('растянутое через паузу слово меряется по своему началу, а не по чужой речи', () => {
  // Whisper тянет конец слова до начала следующего: здесь «слово» длится 3 с,
  // но в первые 0.8 с звучит только левый канал.
  const frames = 150;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < 40; i++) left[i] = 0.01;
  for (let i = 40; i < frames; i++) right[i] = 0.05;

  assert.equal(dominantChannel({ frameSec: 0.02, left, right }, 0, 3), 'left');
});
