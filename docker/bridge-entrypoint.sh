#!/usr/bin/env bash
# Entrypoint for the opencode-bridge container.
#
#  - prepares the writable directories (named volumes in docker-compose.yml)
#  - seeds config files into a fresh volume from the read-only image seed
#  - quarantines a corrupt registry so the registry fallback chain
#    (models.json -> models.json.bak -> models.default.json) can work
#  - execs the bridge so it becomes PID 1 and receives SIGTERM directly
set -Eeuo pipefail

APP_DIR="${OPENCODE_FREE_BRIDGE_DIR:-/app}"
SEED_DIR="/opt/bridge/seed"

mkdir -p "${APP_DIR}/config" "${APP_DIR}/state" "${APP_DIR}/backups" "${APP_DIR}/logs" "${APP_DIR}/run"

seed_if_missing() {
  local name="$1"
  if [ ! -e "${APP_DIR}/config/${name}" ] && [ -e "${SEED_DIR}/${name}" ]; then
    cp "${SEED_DIR}/${name}" "${APP_DIR}/config/${name}"
    echo "[bridge-entrypoint] seeded config/${name}"
  fi
}

seed_if_missing models.default.json
seed_if_missing exclusions.json
seed_if_missing metadata.json

if [ -e "${APP_DIR}/config/models.json" ]; then
  if ! node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" "${APP_DIR}/config/models.json" >/dev/null 2>&1; then
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    mv "${APP_DIR}/config/models.json" "${APP_DIR}/config/models.json.corrupt.${stamp}"
    echo "[bridge-entrypoint] config/models.json was not valid JSON; moved aside to models.json.corrupt.${stamp}"
  fi
fi

exec node "${APP_DIR}/server.mjs"
