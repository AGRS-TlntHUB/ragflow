#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/vite-dev.pid"
LOG_FILE="$RUN_DIR/vite-dev.log"
COMPOSE_FILE="docker/docker-compose.yml"
RAGFLOW_IMAGE="$(awk -F= '/^RAGFLOW_IMAGE=/{print $2}' "$ROOT_DIR/docker/.env")"
DAEMON_MODE=""
BUILD_IMAGE=0
RESTART_ONLY=0

while (($#)); do
  case "$1" in
    -d)
      DAEMON_MODE="-d"
      ;;
    --build|--rebuild)
      BUILD_IMAGE=1
      ;;
    --restart)
      RESTART_ONLY=1
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--build] [--restart] [-d]" >&2
      exit 1
      ;;
  esac
  shift
done

if [ -f "$ROOT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.venv/bin/activate"
fi

cd "$ROOT_DIR"

if [ -z "$RAGFLOW_IMAGE" ]; then
  echo "RAGFLOW_IMAGE is not set in docker/.env" >&2
  exit 1
fi

echo "Using RAGFlow image: $RAGFLOW_IMAGE"

if [ "$RESTART_ONLY" -eq 1 ]; then
  docker compose -f "$COMPOSE_FILE" restart ragflow-cpu
elif [ "$BUILD_IMAGE" -eq 1 ]; then
  docker build --platform linux/amd64 -f Dockerfile -t "$RAGFLOW_IMAGE" .
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate mysql redis minio infinity ragflow-cpu
else
  docker compose -f "$COMPOSE_FILE" up -d mysql redis minio infinity ragflow-cpu
fi

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
