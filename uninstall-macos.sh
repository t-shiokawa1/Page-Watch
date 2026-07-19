#!/bin/bash
set -euo pipefail

LABEL="local.pagewatch.monitor"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ -f "$PLIST_PATH" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
  rm "$PLIST_PATH"
fi

echo "バックグラウンド監視を解除しました。監視URLと履歴は削除していません。"
