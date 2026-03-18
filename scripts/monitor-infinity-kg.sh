#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
INTERVAL="${1:-2}"
OUT_FILE="${2:-$RUN_DIR/infinity-kg-debug-$(date -u +%Y%m%dT%H%M%SZ).log}"

if [ -f "$ROOT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.venv/bin/activate"
fi

mkdir -p "$RUN_DIR"

echo "# interval_seconds=$INTERVAL" >"$OUT_FILE"
echo "# started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$OUT_FILE"
echo "# format: ts_utc | infinity_state | ragflow_probe" >>"$OUT_FILE"

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

  infinity_state="$(docker inspect docker-infinity-1 \
    --format 'restart={{.RestartCount}} running={{.State.Running}} status={{.State.Status}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>&1 || true)"

  ip_probe="$(docker exec docker-ragflow-cpu-1 python -c "import socket; print(socket.gethostbyname('infinity'))" 2>&1 || true)"
  tcp_probe="$(docker exec docker-ragflow-cpu-1 python -c "import socket; s=socket.socket(); s.settimeout(2); rc=s.connect_ex(('infinity',23817)); s.close(); print('ok' if rc==0 else f'err:{rc}')" 2>&1 || true)"
  http_probe="$(curl -sS --max-time 2 http://localhost:23820/admin/node/current 2>&1 || true)"
  ragflow_probe="ip=${ip_probe} tcp23817=${tcp_probe} http23820=${http_probe}"

  printf '%s | %s | %s\n' "$ts" "$infinity_state" "$ragflow_probe" | tee -a "$OUT_FILE"
  sleep "$INTERVAL"
done
