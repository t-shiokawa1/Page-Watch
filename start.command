#!/bin/bash
set -euo pipefail

PAGEWATCH_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PAGEWATCH_UI_URL="${PAGEWATCH_UI_URL:-https://t-shiokawa1.github.io/pagewatch/}"
cd "$PAGEWATCH_DIR"

if [[ ! -f "$PAGEWATCH_DIR/dist/index.html" ]]; then
  echo "画面を準備しています…"
  npm install
  npm run build
fi

if /usr/bin/curl --fail --silent --max-time 1 "http://127.0.0.1:8765/api/health" >/dev/null 2>&1; then
  open "$PAGEWATCH_UI_URL"
  exit 0
fi

exec /usr/bin/python3 "$PAGEWATCH_DIR/server.py" --open --open-url "$PAGEWATCH_UI_URL"
