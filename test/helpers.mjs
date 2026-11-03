import { JSDOM } from 'jsdom';

export const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Разметка, повторяющая плитки участников Meet. */
export function meetLikeDom() {
  const dom = new JSDOM(`
    <div id="grid">
      <div data-participant-id="p1"><div class="name">Иван</div><div class="mic"></div></div>
      <div data-participant-id="p2"><div class="name">Мария</div><div class="mic"></div></div>
    </div>
  `);
  return dom.window.document;
}

/**
 * Непрерывная «речь»: индикатор дрожит всё время, как в настоящем Meet.
 * Мгновенный всплеск речью не считается — детект намеренно его игнорирует.
 */
export async function speakFor(document, participantId, ms) {
  const indicator = document.querySelector(`[data-participant-id="${participantId}"] .mic`);
  const until = Date.now() + ms;
  let step = 0;

  while (Date.now() < until) {
    for (let i = 0; i < 5; i++) indicator.style.height = `${step++ % 5}px`;
    await settle(5);
  }
}
