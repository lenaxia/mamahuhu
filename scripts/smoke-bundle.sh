#!/usr/bin/env bash
# Boots the BUILT bundle and expects a healthy JSON response from /healthz.
# Vitest runs from source and cannot catch bundle-only breakage (the v0.5.0 crashloop).
set -euo pipefail
npm run build >/dev/null
SQLITE_PATH="$(mktemp -u /tmp/mmh-smoke-XXXX).db" PORT=4719 LLM_MOCK=1 DATA_DIR="$(mktemp -d)" node dist/server.js &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  sleep 1
  if curl -sf --max-time 2 http://localhost:4719/healthz | grep -q '"ok":true'; then
    echo "bundle smoke: OK"
    exit 0
  fi
done
echo "bundle smoke: FAILED — dist/server.js does not serve /healthz"
exit 1
