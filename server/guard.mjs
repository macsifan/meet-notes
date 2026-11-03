/**
 * Кого сервер пускает. Слушать 127.0.0.1 мало: любой открытый в браузере
 * сайт может постучаться на localhost, а через DNS rebinding — ещё и прочитать
 * ответ. Поэтому проверяются оба заголовка:
 *
 * - Host — только 127.0.0.1 или localhost на нашем порту (отсекает rebinding);
 * - Origin — либо его нет (адрес открыт вручную, переход по ссылке),
 *   либо это страница расширения. CORS-заголовков сервер не отдаёт вовсе:
 *   расширению они не нужны, у него host_permissions на этот адрес.
 *
 * @param {{host?: string, origin?: string}} headers
 * @param {number} port
 * @returns {boolean}
 */
export function isTrustedRequest({ host, origin }, port) {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(host ?? '')) return false;

  if (!origin) return true;
  return origin.startsWith('chrome-extension://') || allowedHosts.some((h) => origin === `http://${h}`);
}
