#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/vite-dev.pid"
COMPOSE_FILE="docker/docker-compose.yml"
STOP_DOCKER=1

if [ -f "$ROOT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.venv/bin/activate"
fi

while (($#)); do
  case "$1" in
    --frontend-only)
      STOP_DOCKER=0
      ;;
    --all)
      STOP_DOCKER=1
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--frontend-only]" >&2
      exit 1
      ;;
  esac
  shift
done

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" || true
  fi
  rm -f "$PID_FILE"
fi

pkill -f "vite --host" || true

if [ "$STOP_DOCKER" -eq 1 ]; then
  cd "$ROOT_DIR"
  docker compose -f "$COMPOSE_FILE" stop ragflow-cpu mysql redis minio infinity
fi
