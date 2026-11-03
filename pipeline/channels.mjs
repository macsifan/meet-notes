/**
 * Кто говорит, по стерео-записи: расширение пишет микрофон в левый канал,
 * собеседников в правый. Громкость канала на отрезке слова говорит, чей это
 * голос, и не зависит от того, успел ли Meet подсветить плитку.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const SAMPLE_RATE = 16000;
const FRAME_SEC = 0.02;
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_SEC;
const BYTES_PER_FRAME = FRAME_SAMPLES * 2 /* канала */ * 2; /* байта s16le */

/** Средняя мощность ниже этой (около -60 дБ) — тишина, судить не по чему. */
const SILENCE_POWER = 1e-6;

/** Канал считается говорящим, если он громче другого хотя бы вдвое (3 дБ). */
const DOMINANCE = 2;

/**
 * Конец слова Whisper растягивает до начала следующего, через всю паузу.
 * Мерить громкость по такому отрезку значит мерить чужую речь, поэтому окно
 * ограничено типичной длиной слова.
 */
const MAX_WINDOW_SEC = 0.8;

/**
 * Мощность каждого канала по кадрам 20 мс. Файл читается потоком:
 * час стерео — это 230 МБ, держать его в памяти целиком незачем.
 * @param {string} rawPath PCM s16le, 16 кГц, 2 канала вперемешку
 * @returns {Promise<{frameSec: number, left: Float32Array, right: Float32Array}>}
 */
export async function channelEnergy(rawPath) {
  const { size } = await stat(rawPath);
  const frames = Math.floor(size / BYTES_PER_FRAME);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  let frame = 0;
  let pending = Buffer.alloc(0);

  for await (const chunk of createReadStream(rawPath)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;

    while (offset + BYTES_PER_FRAME <= pending.length && frame < frames) {
      let sumLeft = 0;
      let sumRight = 0;
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const l = pending.readInt16LE(offset + i * 4) / 32768;
        const r = pending.readInt16LE(offset + i * 4 + 2) / 32768;
        sumLeft += l * l;
        sumRight += r * r;
      }
      left[frame] = sumLeft / FRAME_SAMPLES;
      right[frame] = sumRight / FRAME_SAMPLES;
      frame += 1;
      offset += BYTES_PER_FRAME;
    }
    pending = pending.subarray(offset);
  }

  return { frameSec: FRAME_SEC, left, right };
}

/**
 * @param {{frameSec: number, left: Float32Array, right: Float32Array}} energy
 * @param {number} start секунды
 * @param {number} end секунды
 * @returns {'left'|'right'|null} null — тишина или оба канала звучат одинаково
 */
export function dominantChannel({ frameSec, left, right }, start, end) {
  const from = Math.max(0, Math.floor(start / frameSec));
  const to = Math.min(left.length, Math.ceil(Math.min(end, start + MAX_WINDOW_SEC) / frameSec));
  if (to <= from) return null;

  let sumLeft = 0;
  let sumRight = 0;
  for (let i = from; i < to; i++) {
    sumLeft += left[i];
    sumRight += right[i];
  }

  if (Math.max(sumLeft, sumRight) / (to - from) < SILENCE_POWER) return null;
  if (sumLeft > sumRight * DOMINANCE) return 'left';
  if (sumRight > sumLeft * DOMINANCE) return 'right';
  return null;
}
