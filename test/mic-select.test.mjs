import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickMicrophone } from '../extension/mic-select.js';

const mic = (deviceId, label) => ({ kind: 'audioinput', deviceId, label });

test('встроенный микрофон Mac выбирается вместо iPhone, даже если iPhone — устройство по умолчанию', () => {
  const devices = [
    mic('default', 'Default — iPhone Microphone'),
    mic('phone1', 'iPhone Microphone (Continuity)'),
    mic('mac1', 'MacBook Pro Microphone (Built-in)'),
  ];

  assert.equal(pickMicrophone(devices), 'mac1');
});

test('русские подписи устройств тоже распознаются', () => {
  const devices = [
    mic('phone1', 'Микрофон iPhone'),
    mic('mac1', 'Микрофон MacBook Pro (встроенный)'),
  ];

  assert.equal(pickMicrophone(devices), 'mac1');
});

test('без встроенного берётся любой микрофон, кроме телефона', () => {
  const devices = [
    mic('phone1', 'iPhone Microphone'),
    mic('pods1', 'AirPods Pro'),
  ];

  assert.equal(pickMicrophone(devices), 'pods1');
});

test('если кроме телефона ничего нет, возвращается undefined — система решит сама', () => {
  const devices = [mic('phone1', 'iPhone Microphone')];

  assert.equal(pickMicrophone(devices), undefined);
});

test('камеры и динамики не участвуют в выборе', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'cam1', label: 'MacBook Pro Camera' },
    { kind: 'audiooutput', deviceId: 'out1', label: 'MacBook Pro Speakers' },
    mic('mac1', 'MacBook Pro Microphone'),
  ];

  assert.equal(pickMicrophone(devices), 'mac1');
});

test('пустой список устройств не роняет выбор', () => {
  assert.equal(pickMicrophone([]), undefined);
});
