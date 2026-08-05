#!/usr/bin/env bash
# Start product BFF in real-net mode (no demo candidate seeds).
# Usage: product/scripts/start-bff-realnet.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PRODUCT_ENV_PATH="${PRODUCT_ENV_PATH:-$ROOT/.env}"
export DEMO_HR_PIPELINE=0
export DIGITAL_EMPLOYEE_DEV_GRANT="${DIGITAL_EMPLOYEE_DEV_GRANT:-hr-recruitment}"
export HR_INTENT_LLM="${HR_INTENT_LLM:-1}"
cd "$ROOT/backend"
echo "Starting BFF real-net: DEMO_HR_PIPELINE=0 PRODUCT_ENV_PATH=$PRODUCT_ENV_PATH"
exec node src/server.js
