#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/vite-dev.pid"

if [ -f "$ROOT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.venv/bin/activate"
fi

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" || true
  fi
  rm -f "$PID_FILE"
fi

pkill -f "vite --host" || true

if [ "${1:-}" = "--all" ]; then
  cd "$ROOT_DIR"
  docker compose -f docker/docker-compose.yml stop ragflow-cpu mysql redis minio infinity
fi
