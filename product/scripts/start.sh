#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRODUCT="$ROOT/product"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$PRODUCT/backend"
if [ ! -d node_modules ]; then
  pnpm install || npm install
fi

echo "Starting product BFF on http://127.0.0.1:8787 ..."
exec node src/server.js
