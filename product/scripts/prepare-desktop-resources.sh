#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

STAGE="$ROOT/desktop/packaging-resources"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# SECURITY: never copy product/.env, MySQL passwords, or gateway tokens into the Windows package.
# Packaged desktop is a thin client that only knows a public serverUrl.

# Public config only
PUBLIC_URL="${PRODUCT_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ]; then
  echo "ERROR: PRODUCT_PUBLIC_URL is required for distributable desktop builds" >&2
  exit 1
fi
if [[ ! "$PUBLIC_URL" =~ ^https:// ]]; then
  echo "ERROR: PRODUCT_PUBLIC_URL must use public HTTPS: $PUBLIC_URL" >&2
  exit 1
fi
if [[ "$PUBLIC_URL" =~ (localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
  echo "ERROR: PRODUCT_PUBLIC_URL must not be a loopback or private-network address: $PUBLIC_URL" >&2
  exit 1
fi
cat > "$STAGE/public-config.json" <<EOF
{
  "serverUrl": "${PUBLIC_URL}"
}
EOF

# Guardrails: fail if secrets accidentally appear in staging
if rg -n "OPENCLAW_GATEWAY_TOKEN|MYSQL_PASSWORD|SESSION_SECRET|password_hash" "$STAGE" >/dev/null 2>&1; then
  echo "ERROR: secret-like content found in packaging stage" >&2
  exit 1
fi
if [ -f "$STAGE/.env" ] || [ -f "$STAGE/backend/.env" ]; then
  echo "ERROR: .env must not be packaged" >&2
  exit 1
fi

echo "Thin-client packaging staged at $STAGE"
cat "$STAGE/public-config.json"
