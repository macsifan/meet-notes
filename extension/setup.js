const micState = document.getElementById('micState');
const serverState = document.getElementById('serverState');

function show(element, text, ok) {
  element.textContent = text;
  element.className = `state ${ok ? 'ok' : 'fail'}`;
}

document.getElementById('requestMic').addEventListener('click', async () => {
  try {
    // Разрешение выдаётся origin'у расширения и потом доступно offscreen-документу,
    // который сам показать этот запрос не может.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    show(micState, '✓ Микрофон разрешён', true);
  } catch (error) {
    show(micState, `✗ Не удалось получить доступ: ${error.message}`, false);
  }
});

document.getElementById('checkServer').addEventListener('click', async () => {
  try {
    const response = await fetch('http://127.0.0.1:8788/status');
    const { queue } = await response.json();
    show(serverState, `✓ Сервер работает, в очереди записей: ${queue}`, true);
  } catch {
    show(serverState, '✗ Сервер не отвечает — запустите npm run server', false);
  }
});
