#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Default port; override via .env PORT=
PORT=3847
if [[ -f .env ]]; then
  val="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- | tr -d ' "'\''')"
  [[ -n "$val" ]] && PORT="$val"
fi

echo "Stopping backend on port ${PORT}…"
pids="$(lsof -ti:"${PORT}" 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  echo "$pids" | xargs kill -TERM 2>/dev/null || true
  sleep 1
  remaining="$(lsof -ti:"${PORT}" 2>/dev/null || true)"
  if [[ -n "$remaining" ]]; then
    echo "$remaining" | xargs kill -9 2>/dev/null || true
  fi
  echo "Stopped."
else
  echo "Nothing listening on port ${PORT}."
fi

echo "Starting backend (ngrok left running if already up)…"
exec npm start
