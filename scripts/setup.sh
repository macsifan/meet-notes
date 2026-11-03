#!/bin/bash
# Первичная установка: инструменты распознавания и модель Whisper.
# Повторный запуск безопасен — уже установленное пропускается.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_PATH="$PROJECT_DIR/models/ggml-large-v3-turbo.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"

echo "→ проверяю инструменты"
MISSING=()
command -v ffmpeg > /dev/null || MISSING+=("ffmpeg")
command -v whisper-cli > /dev/null || MISSING+=("whisper-cpp")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  command -v brew > /dev/null || { echo "✗ нужен Homebrew: https://brew.sh"; exit 1; }
  echo "→ ставлю: ${MISSING[*]}"
  brew install "${MISSING[@]}"
else
  echo "  ffmpeg и whisper.cpp уже есть"
fi

# Выжимку делает Claude Code по подписке, поэтому отдельный API-ключ не нужен.
command -v claude > /dev/null || {
  echo "✗ не найден claude — установите Claude Code: https://claude.com/claude-code"
  exit 1
}

mkdir -p "$PROJECT_DIR/models" "$PROJECT_DIR/data/notes" "$PROJECT_DIR/data/recordings"

if [[ -f "$MODEL_PATH" ]]; then
  echo "  модель распознавания уже скачана"
else
  echo "→ качаю модель распознавания (~1.6 ГБ, один раз)"
  curl -L --fail --progress-bar -o "$MODEL_PATH" "$MODEL_URL"
fi

echo
echo "✓ готово. Дальше:"
echo "  npm install && npm test     — проверить сборку"
echo "  npm run server              — поднять сервер заметок"
echo "  chrome://extensions         — загрузить распакованное расширение из extension/"
