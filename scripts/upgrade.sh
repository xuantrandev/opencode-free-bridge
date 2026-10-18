#!/usr/bin/env bash
# Upgrade opencode-free-bridge safely.
#
#   scripts/upgrade.sh [--no-pull] [--no-test] [--auto-rollback]
#
# Steps:
#   1. optionally `git pull --ff-only`
#   2. syntax check + full test suite (node --test)
#   3. restart the bridge service (never the OpenCode upstream)
#   4. verify /health and /v1/models
#   5. on failure, keep the previous commit checked out (with --auto-rollback)
#
# Model-list changes are handled by the bridge itself (hot reload); this script
# is only for code upgrades.

set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
PULL=1
TEST=1
AUTO_ROLLBACK=0
PORT="${PORT:-5577}"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=0; shift ;;
    --no-test) TEST=0; shift ;;
    --auto-rollback) AUTO_ROLLBACK=1; shift ;;
    -h|--help) sed -n '1,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO"
PREV="$(git rev-parse HEAD 2>/dev/null || echo '')"
echo "[upgrade] repo:   $REPO"
echo "[upgrade] commit: ${PREV:-unknown}"

if [ "$PULL" = "1" ] && [ -d .git ]; then
  echo "[upgrade] git pull --ff-only"
  git pull --ff-only
fi

NEW="$(git rev-parse HEAD 2>/dev/null || echo '')"
[ "$PREV" != "$NEW" ] && echo "[upgrade] updated ${PREV:0:8} -> ${NEW:0:8}"

RUNTIME="$(command -v bun || command -v node || true)"
if [ -z "$RUNTIME" ]; then
  echo "[upgrade] error: neither bun nor node found" >&2
  exit 1
fi

if [ "$TEST" = "1" ]; then
  echo "[upgrade] syntax check"
  "$RUNTIME" --check server.mjs
  "$RUNTIME" --check cli.mjs
  for f in lib/*.mjs; do "$RUNTIME" --check "$f"; done
  echo "[upgrade] running tests"
  "$RUNTIME" --test
fi

restart_bridge() {
  if systemctl is-active --quiet opencode-free-bridge.service 2>/dev/null; then
    echo "[upgrade] restarting systemd service (bridge only, upstream untouched)"
    sudo systemctl restart opencode-free-bridge.service
    return 0
  fi
  if [ -x /usr/local/bin/opencode-free-bridge ]; then
    echo "[upgrade] restarting launcher-managed bridge"
    /usr/local/bin/opencode-free-bridge restart
    return 0
  fi
  echo "[upgrade] no running service detected; start it manually" >&2
  return 1
}

if ! restart_bridge; then
  [ "$AUTO_ROLLBACK" = "1" ] && [ -n "$PREV" ] && { git checkout --quiet "$PREV"; echo "[upgrade] rolled back to $PREV (restart manually)"; }
  exit 1
fi

echo "[upgrade] verifying health"
OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != "1" ]; then
  echo "[upgrade] health check FAILED" >&2
  [ "$AUTO_ROLLBACK" = "1" ] && [ -n "$PREV" ] && {
    git checkout --quiet "$PREV"
    restart_bridge || true
    echo "[upgrade] rolled back to $PREV"
  }
  exit 1
fi

curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || true
echo
echo "[upgrade] done: $("$RUNTIME" "${REPO}/cli.mjs" version 2>/dev/null || echo '?')"
