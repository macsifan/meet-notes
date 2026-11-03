#!/bin/bash
# Ставит сервер заметок на автозапуск при входе в систему (launchd).
#
#   bash scripts/install-autostart.sh          — установить
#   bash scripts/install-autostart.sh --remove — убрать
#
# Скрипт не запускается сам по себе: автозапуск — осознанное изменение системы.

set -euo pipefail

LABEL="com.meetnotes.server"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ автозапуск снят"
  exit 0
fi

NODE_BIN="$(command -v node)"
# claude, ffmpeg и whisper-cli вызываются пайплайном, поэтому их каталоги
# должны быть в PATH процесса launchd — он не читает профиль пользователя.
BIN_PATHS="$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Лог держим вне Desktop/Documents: к ним у launchd нет доступа (TCC),
# и служба падает с EX_CONFIG ещё до старта node.
LOG_FILE="$HOME/Library/Logs/meet-notes.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$PROJECT_DIR/data"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$PROJECT_DIR/server/index.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$BIN_PATHS</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- Без этого launchd даёт фоновый приоритет, и whisper работает в разы медленнее -->
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$LOG_FILE</string>
    <key>StandardErrorPath</key>
    <string>$LOG_FILE</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 3
if curl -sf http://127.0.0.1:8788/status > /dev/null; then
  echo "✓ сервер запущен и будет подниматься при входе в систему"
  echo "  заметки: http://127.0.0.1:8788/"
  echo "  лог:     $LOG_FILE"
else
  echo "✗ сервер не отвечает — смотрите $LOG_FILE"
  echo "  Если в логе EACCES/EPERM: Настройки → Конфиденциальность → Полный доступ к диску → добавить $NODE_BIN"
  exit 1
fi
