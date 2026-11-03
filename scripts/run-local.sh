#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_PORT="${FRONTEND_PORT:-8000}"
BACKEND_PORT="${BACKEND_PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
PASSWORD="${TCRS_PASSWORD:-local-dev-password}"
ALLOWED_ORIGIN="http://${HOST}:${FRONTEND_PORT}"

mkdir -p "$ROOT_DIR/data"

python3 -m http.server "$FRONTEND_PORT" --directory "$ROOT_DIR/frontend" >/tmp/tcrs-frontend.log 2>&1 &
FRONTEND_PID=$!

TCRS_PASSWORD="$PASSWORD" \
TCRS_SITE_DIR="$ROOT_DIR/frontend" \
TCRS_DATA_DIR="$ROOT_DIR/data" \
TCRS_ALLOWED_ORIGINS="$ALLOWED_ORIGIN" \
HOST="$HOST" \
PORT="$BACKEND_PORT" \
python3 -m backend >/tmp/tcrs-backend.log 2>&1 &
BACKEND_PID=$!

cleanup() {
  kill "$FRONTEND_PID" "$BACKEND_PID" 2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "Frontend: http://${HOST}:${FRONTEND_PORT}"
echo "Backend:  http://${HOST}:${BACKEND_PORT}/healthz"
echo "Password: ${PASSWORD}"
echo "Press Ctrl+C to stop both services"

wait "$BACKEND_PID"
