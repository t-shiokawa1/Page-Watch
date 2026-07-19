#!/bin/bash
set -euo pipefail

PAGEWATCH_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LABEL="local.pagewatch.monitor"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_DIR/$LABEL.plist"

cd "$PAGEWATCH_DIR"
if [[ ! -f "$PAGEWATCH_DIR/dist/index.html" ]]; then
  npm install
  npm run build
fi

mkdir -p "$LAUNCH_DIR" "$PAGEWATCH_DIR/data"
chmod +x "$PAGEWATCH_DIR/server.py" "$PAGEWATCH_DIR/start.command"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$PAGEWATCH_DIR/server.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PAGEWATCH_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$PAGEWATCH_DIR/data/launch-output.log</string>
  <key>StandardErrorPath</key>
  <string>$PAGEWATCH_DIR/data/launch-error.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

sleep 1
open "http://127.0.0.1:8765"
echo "PageWatchをインストールしました。ブラウザを閉じても監視を続けます。"
