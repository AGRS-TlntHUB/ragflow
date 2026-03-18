#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/vite-dev.pid"
LOG_FILE="$RUN_DIR/vite-dev.log"
DAEMON_MODE="${1:-}"

if [ -f "$ROOT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.venv/bin/activate"
fi

cd "$ROOT_DIR"
docker compose -f docker/docker-compose.yml up -d mysql redis minio infinity ragflow-cpu

cd "$ROOT_DIR/web"
if [ ! -d node_modules ]; then
  npm install
fi

mkdir -p "$RUN_DIR"

if [ "$DAEMON_MODE" = "-d" ]; then
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "vite dev server already running (pid $(cat "$PID_FILE"))"
    echo "log: $LOG_FILE"
    exit 0
  fi
  nohup env API_PROXY_SCHEME=python npm run dev >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "vite dev server started in daemon mode (pid $(cat "$PID_FILE"))"
  echo "log: $LOG_FILE"
  exit 0
fi

API_PROXY_SCHEME=python npm run dev
