#!/usr/bin/env bash
# Production entrypoint: start the ML service and the backend, wait until both
# answer, then seed the 20 demo patients so a fresh (in-memory) deployment is
# never empty. If either service dies, exit so the platform restarts the
# container rather than serving a half-working app.
set -uo pipefail

PORT="${PORT:-7860}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

(cd "$ROOT/ml-service" && exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8000) &
ML_PID=$!
(cd "$ROOT/backend" && exec node src/server.js) &
API_PID=$!

wait_for() {
  for _ in $(seq 1 90); do
    node -e "fetch('$1').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" && return 0
    sleep 1
  done
  echo "[start] $1 did not come up"
  return 1
}

wait_for "http://127.0.0.1:${PORT}/api/health"
wait_for "http://127.0.0.1:8000/health"

if [ "${SEED_ON_START:-true}" = "true" ]; then
  (cd "$ROOT/backend" && API_URL="http://127.0.0.1:${PORT}/api" node scripts/seed.js) \
    || echo "[start] seed finished with warnings; the app is still up"
fi

wait -n "$ML_PID" "$API_PID"
echo "[start] a service exited; stopping so the platform restarts the container"
kill "$ML_PID" "$API_PID" 2>/dev/null
exit 1
