#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/database"

if [[ ! -f .next/BUILD_ID ]]; then
  echo "[start.sh] Missing Next.js production build. Running npm run build..."
  npm run build
fi

exec node scripts/start-production.mjs
