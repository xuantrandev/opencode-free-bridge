#!/usr/bin/env bash
# Install/upgrade opencode-free-bridge as a systemd service for a non-root user.
#
#   sudo scripts/install.sh [--user ubuntu] [--with-timer] [--no-start]
#
# What it does:
#   - installs /usr/local/bin/opencode-free-bridge -> <repo>/scripts/opencode-free-bridge
#   - generates systemd units with paths that actually exist on this machine
#   - enables opencode-serve.service + opencode-free-bridge.service
#   - optionally enables the external sync timer (only if MODEL_AUTO_SYNC=false)
#
# It never touches your OpenCode credentials (~/.local/share/opencode, ~/.config/opencode).

set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TARGET_USER="${SUDO_USER:-ubuntu}"
WITH_TIMER=0
START=1
OC_PORT="${OC_PORT:-4577}"
BRIDGE_PORT="${BRIDGE_PORT:-5577}"

while [ $# -gt 0 ]; do
  case "$1" in
    --user) TARGET_USER="$2"; shift 2 ;;
    --with-timer) WITH_TIMER=1; shift ;;
    --no-start) START=0; shift ;;
    --oc-port) OC_PORT="$2"; shift 2 ;;
    --port) BRIDGE_PORT="$2"; shift 2 ;;
    -h|--help) sed -n '1,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "error: run with sudo (systemd units must be installed as root)" >&2
  exit 1
fi

if ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "error: user '$TARGET_USER' does not exist" >&2
  exit 1
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"
HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6)"

echo "[install] repo:        $REPO"
echo "[install] service user: $TARGET_USER ($TARGET_GROUP), home $HOME_DIR"

# --- 1. runtime + opencode binary detection (as the target user) ------------
RUNTIME="$(sudo -u "$TARGET_USER" -H bash -lc 'command -v bun || command -v node' 2>/dev/null || true)"
if [ -z "$RUNTIME" ]; then
  echo "error: neither bun nor node found for user $TARGET_USER" >&2
  exit 1
fi
OPENCODE_BIN="$(sudo -u "$TARGET_USER" -H bash -lc 'command -v opencode' 2>/dev/null || true)"
if [ -z "$OPENCODE_BIN" ]; then
  for candidate in \
    "$HOME_DIR/.opencode/bin/opencode" \
    "$HOME_DIR/.local/bin/opencode" \
    /usr/local/bin/opencode \
    /usr/bin/opencode; do
    if [ -x "$candidate" ]; then OPENCODE_BIN="$candidate"; break; fi
  done
fi
echo "[install] runtime:      $RUNTIME"
echo "[install] opencode:     ${OPENCODE_BIN:-<not found — opencode-serve.service will need it on PATH>}"

# --- 2. writable runtime dirs ------------------------------------------------
install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0755 \
  "$REPO/config" "$REPO/state" "$REPO/logs" "$REPO/backups" "$REPO/run"

# --- 3. launcher -------------------------------------------------------------
chmod 0755 "$REPO/scripts/opencode-free-bridge" "$REPO/scripts/install.sh" "$REPO/scripts/upgrade.sh" 2>/dev/null || true
ln -sfn "$REPO/scripts/opencode-free-bridge" /usr/local/bin/opencode-free-bridge
echo "[install] launcher:     /usr/local/bin/opencode-free-bridge -> $REPO/scripts/opencode-free-bridge"

# --- 4. systemd units --------------------------------------------------------
TMP_UNITS="$(mktemp -d)"
trap 'rm -rf "$TMP_UNITS"' EXIT

patch_unit() {
  # patch_unit <source> <destination> [sed args...]
  local src="$1" dst="$2"; shift 2
  sed -e "s|^User=ubuntu$|User=$TARGET_USER|" \
      -e "s|^Group=ubuntu$|Group=$TARGET_GROUP|" \
      -e "s|/home/ubuntu/opencode-free-bridge|$REPO|g" \
      -e "s|--port 4577|--port $OC_PORT|g" \
      "$@" "$src" > "$dst"
}

patch_unit "$REPO/scripts/opencode-serve.service" "$TMP_UNITS/opencode-serve.service"
if [ -n "$OPENCODE_BIN" ]; then
  sed -i -e "s|^ExecStart=.*opencode serve.*$|ExecStart=$OPENCODE_BIN serve --port $OC_PORT --hostname 127.0.0.1|" "$TMP_UNITS/opencode-serve.service"
fi

patch_unit "$REPO/scripts/opencode-free-bridge.service" "$TMP_UNITS/opencode-free-bridge.service"
sed -i -e "s|^ExecStart=.*server\.mjs.*$|ExecStart=$RUNTIME $REPO/server.mjs|" "$TMP_UNITS/opencode-free-bridge.service"

patch_unit "$REPO/scripts/opencode-free-bridge-sync.service" "$TMP_UNITS/opencode-free-bridge-sync.service"
sed -i -e "s|^ExecStart=.*cli\.mjs.*$|ExecStart=$RUNTIME $REPO/cli.mjs models sync --quiet|" "$TMP_UNITS/opencode-free-bridge-sync.service"

patch_unit "$REPO/scripts/opencode-free-bridge-sync.timer" "$TMP_UNITS/opencode-free-bridge-sync.timer"

install -m 0644 "$TMP_UNITS/opencode-serve.service" /etc/systemd/system/opencode-serve.service
install -m 0644 "$TMP_UNITS/opencode-free-bridge.service" /etc/systemd/system/opencode-free-bridge.service
install -m 0644 "$TMP_UNITS/opencode-free-bridge-sync.service" /etc/systemd/system/opencode-free-bridge-sync.service
install -m 0644 "$TMP_UNITS/opencode-free-bridge-sync.timer" /etc/systemd/system/opencode-free-bridge-sync.timer
systemctl daemon-reload

# --- 5. .env defaults (never overwrite existing values) -----------------------
ENV_FILE="$REPO/.env"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$REPO/.env.example" ]; then
    cp "$REPO/.env.example" "$ENV_FILE"
    chown "$TARGET_USER:$TARGET_GROUP" "$ENV_FILE"
    echo "[install] created $ENV_FILE from .env.example"
  fi
fi

if [ -n "$OPENCODE_BIN" ] && [ -f "$ENV_FILE" ] && ! grep -q '^OPENCODE_BIN=' "$ENV_FILE"; then
  printf '\n# absolute path to the OpenCode CLI (model discovery)\nOPENCODE_BIN=%s\n' "$OPENCODE_BIN" >> "$ENV_FILE"
  chown "$TARGET_USER:$TARGET_GROUP" "$ENV_FILE"
  echo "[install] set OPENCODE_BIN=$OPENCODE_BIN in .env"
fi

if [ "$WITH_TIMER" = "1" ] && [ -f "$ENV_FILE" ]; then
  if grep -q '^MODEL_AUTO_SYNC=' "$ENV_FILE"; then
    sed -i 's|^MODEL_AUTO_SYNC=.*|MODEL_AUTO_SYNC=false|' "$ENV_FILE"
  else
    printf '\n# external systemd timer owns scheduling\nMODEL_AUTO_SYNC=false\n' >> "$ENV_FILE"
  fi
  echo "[install] MODEL_AUTO_SYNC=false (systemd timer will own scheduling)"
fi

# --- 6. enable services -------------------------------------------------------
systemctl enable opencode-serve.service >/dev/null
systemctl enable opencode-free-bridge.service >/dev/null
if [ "$WITH_TIMER" = "1" ]; then
  systemctl enable --now opencode-free-bridge-sync.timer >/dev/null
  echo "[install] enabled opencode-free-bridge-sync.timer"
fi

if [ "$START" = "1" ]; then
  systemctl restart opencode-serve.service
  systemctl restart opencode-free-bridge.service
  sleep 2
  systemctl --no-pager --lines=0 status opencode-free-bridge.service || true
  if curl -sf --max-time 5 "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null; then
    echo "[install] bridge healthy on http://127.0.0.1:${BRIDGE_PORT}"
  else
    echo "[install] WARNING: bridge health check failed; inspect: journalctl -u opencode-free-bridge -n 50" >&2
  fi
fi

echo "[install] done."
echo "  opencode-free-bridge status"
echo "  opencode-free-bridge models sync"
echo "  journalctl -u opencode-free-bridge -f"
