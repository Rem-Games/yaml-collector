#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-4173}"

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
fi

if command -v python >/dev/null 2>&1; then
  exec python -m http.server "$PORT"
fi

echo "Python is required to run a local static server." >&2
exit 1
