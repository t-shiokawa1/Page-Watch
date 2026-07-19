#!/bin/bash
set -euo pipefail

PAGEWATCH_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PAGEWATCH_UI_URL="${PAGEWATCH_UI_URL:-https://t-shiokawa1.github.io/pagewatch/}"
cd "$PAGEWATCH_DIR"

# The Pages UI (PAGEWATCH_UI_URL) only needs the Python API below, which uses
# no external packages. Building the bundled local UI is a bonus for people who
# open http://127.0.0.1:8765 directly, so only do it when npm is available.
if [[ ! -f "$PAGEWATCH_DIR/dist/index.html" ]] && command -v npm >/dev/null 2>&1; then
  echo "画面を準備しています…（初回のみ）"
  npm install && npm run build || echo "ビルドはスキップしました。Web画面から操作できます。"
fi

if /usr/bin/curl --fail --silent --max-time 1 "http://127.0.0.1:8765/api/health" >/dev/null 2>&1; then
  echo "PageWatchはすでに起動しています。"
  open "$PAGEWATCH_UI_URL"
  exit 0
fi

echo "PageWatchを起動しています。このウィンドウは開いたままにしてください。"
exec /usr/bin/python3 "$PAGEWATCH_DIR/server.py" --open --open-url "$PAGEWATCH_UI_URL"
