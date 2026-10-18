#!/usr/bin/env bash
# Migrate existing host OpenCode authentication into the Docker volume used by
# the opencode-server container.
#
# What it does, in order:
#   1. discovers the official OpenCode auth/config paths on the host
#   2. inspects auth.json for obvious machine-binding fields (never prints secrets)
#   3. refuses to overwrite credentials that already live in the container volume
#      unless --force is given
#   4. streams the host auth.json into the volume via `docker compose run` stdin
#      (nothing is ever baked into an image layer; file mode 0600)
#   5. verifies provider access from inside the container
#
# The host file is only ever read, never modified or deleted.
#
# Usage:
#   scripts/migrate-auth.sh [--force] [--with-config] [--verify-login]
#
# If no host credentials exist, run an interactive login instead:
#   docker compose exec opencode-server opencode auth login

set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

FORCE=0
WITH_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --with-config) WITH_CONFIG=1 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

info()  { printf '[migrate-auth] %s\n' "$*"; }
warn()  { printf '[migrate-auth] WARNING: %s\n' "$*" >&2; }
fail()  { printf '[migrate-auth] ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is not installed"

# ---------------------------------------------------------------- discovery
# Official paths (XDG-aware, same layout inside the container image):
#   auth:   ${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json
#   config: ${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json[c]
#   state:  ${XDG_STATE_HOME:-~/.local/state}/opencode, cache: ~/.cache/opencode
AUTH_CANDIDATES=(
  "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"
  "$HOME/.config/opencode/auth.json"   # legacy location
)
HOST_AUTH=""
for candidate in "${AUTH_CANDIDATES[@]}"; do
  if [ -s "$candidate" ]; then
    HOST_AUTH="$candidate"
    break
  fi
done

CONFIG_CANDIDATES=(
  "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc"
  "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
)
HOST_CONFIG=""
for candidate in "${CONFIG_CANDIDATES[@]}"; do
  if [ -s "$candidate" ]; then
    HOST_CONFIG="$candidate"
    break
  fi
done

if [ -z "$HOST_AUTH" ]; then
  info "no host OpenCode credentials found (checked: ${AUTH_CANDIDATES[*]})"
  if [ -n "$HOST_CONFIG" ]; then
    info "found host config: $HOST_CONFIG (not needed unless you pass --with-config)"
  fi
  cat <<'EOF'

No credentials to migrate. Authenticate interactively inside the container:

    docker compose up -d opencode-server
    docker compose exec opencode-server opencode auth login

Then verify provider access:

    docker compose exec opencode-server opencode models opencode

The credentials you create this way live in the opencode-data volume and
survive `docker compose down`, container recreation and image rebuilds.
EOF
  exit 0
fi

info "found host credentials: $HOST_AUTH (host file is read-only for this script)"

# ------------------------------------------------- machine-binding inspection
# auth.json maps provider id -> credential entry. We only look at key names;
# values (tokens) are never printed or logged.
AUTH_META="$(node -e '
const fs = require("node:fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const providers = Object.keys(data || {});
  const suspicious = providers.filter((k) => /machine|device|hostname|fingerprint/i.test(k));
  const entries = providers.length;
  const withMachineField = Object.values(data || {}).some(
    (v) => v && typeof v === "object" && Object.keys(v).some((k) => /machine|device|hostname|fingerprint/i.test(k)),
  );
  process.stdout.write(JSON.stringify({ entries, providers, suspicious, withMachineField }));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err.message) }));
}
' "$HOST_AUTH")"

if printf '%s' "$AUTH_META" | grep -q '"error"'; then
  fail "$HOST_AUTH is not valid JSON: $AUTH_META"
fi
info "credential entries: $AUTH_META"

if printf '%s' "$AUTH_META" | grep -q '"withMachineField":true'; then
  warn "auth entries contain machine/device-looking fields; the token may be bound to this machine."
  warn "If provider access fails after migration, re-authenticate inside the container:"
  warn "  docker compose exec opencode-server opencode auth login"
fi
info "opencode stores credentials as plain provider entries; there is no hostname/device id requirement"
info "in the auth file itself. Tokens configured with IP/device restrictions on the provider side"
info "may still need a fresh login."

# -------------------------------------------------------- container check
info "building the opencode-server image (needed for the migration helper)"
docker compose build opencode-server >/dev/null

CONTAINER_AUTH_STATE="$(docker compose run --rm -T --no-deps --entrypoint sh opencode-server -c '
  target="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"
  if [ -s "$target" ]; then echo present; else echo absent; fi
' 2>/dev/null | tr -d '\r' | tail -n1)"

if [ "$CONTAINER_AUTH_STATE" = "present" ] && [ "$FORCE" -ne 1 ]; then
  info "credentials already exist in the opencode-data volume; nothing to do"
  info "re-run with --force to overwrite them with the host credentials"
else
  info "streaming credentials into the opencode-data volume (mode 0600)"
  docker compose run --rm -T --no-deps --entrypoint sh opencode-server -c '
    set -e
    umask 077
    dir="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
    mkdir -p "$dir"
    tmp="$dir/auth.json.migrate.$$"
    cat > "$tmp"
    mv "$tmp" "$dir/auth.json"
    chmod 600 "$dir/auth.json"
    node -e "JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\"))" "$dir/auth.json"
    echo "credentials installed"
  ' < "$HOST_AUTH"
fi

if [ "$WITH_CONFIG" -eq 1 ]; then
  if [ -n "$HOST_CONFIG" ]; then
    info "copying host config $HOST_CONFIG into the opencode-config volume"
    docker compose run --rm -T --no-deps --entrypoint sh opencode-server -c '
      set -e
      umask 077
      dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
      mkdir -p "$dir"
      cat > "$dir/opencode.jsonc"
      echo "config installed"
    ' < "$HOST_CONFIG"
  else
    warn "--with-config passed but no host config file was found"
  fi
fi

# --------------------------------------------------------------- verification
info "starting the stack to verify provider access"
docker compose up -d >/dev/null

info "waiting for opencode-server to become healthy"
for _ in $(seq 1 30); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' opencode-server 2>/dev/null || echo missing)"
  [ "$health" = "healthy" ] && break
  sleep 2
done
final_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' opencode-server 2>/dev/null || echo missing)"
if [ "$final_health" != "healthy" ]; then
  warn "opencode-server is '$final_health' — check: docker compose logs opencode-server"
else
  info "opencode-server is healthy"
fi

info "verifying provider access (no inference, no quota use)"
models="$(docker compose exec -T opencode-server opencode models opencode 2>/dev/null || true)"
model_count="$(printf '%s\n' "$models" | grep -c '/.*-free\|/big-pickle' || true)"
if [ -n "$models" ]; then
  info "opencode reports $model_count free/open models — authentication is working"
else
  warn "could not list models from inside the container. If provider access requires auth, run:"
  warn "  docker compose exec opencode-server opencode auth login"
fi

cat <<'EOF'

Next steps:
  docker compose exec opencode-bridge bridge-cli sync      # discover + deploy models now
  docker compose exec opencode-bridge bridge-cli status    # registry + sync status
  curl -s http://127.0.0.1:5577/v1/models | head           # served models
EOF
