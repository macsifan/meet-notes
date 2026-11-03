/**
 * Выбор микрофона для записи.
 *
 * getUserMedia без deviceId берёт системное устройство по умолчанию — на Mac
 * это может оказаться iPhone (Continuity): у пользователя внезапно загорается
 * микрофон на телефоне, а голос пишется с устройства, лежащего в стороне.
 * Поэтому телефонные микрофоны обходим, встроенный в Mac — предпочитаем.
 */

const PHONE = /iphone|ipad|continuity/i;
const BUILT_IN = /macbook|built-?in|встроенн/i;

/**
 * @param {{kind: string, deviceId: string, label: string}[]} devices результат enumerateDevices()
 * @returns {string|undefined} deviceId, или undefined — пусть система решает сама
 */
export function pickMicrophone(devices) {
  const microphones = devices.filter((device) => device.kind === 'audioinput');

  const builtIn = microphones.find((device) => BUILT_IN.test(device.label));
  if (builtIn) return builtIn.deviceId;

  const notPhone = microphones.find((device) => !PHONE.test(device.label));
  return notPhone?.deviceId;
}
