#!/usr/bin/env bash
# Entrypoint for the opencode-server container.
#
# Prepares persistent XDG directories (named volumes in docker-compose.yml)
# and hands over to the discovery agent, which supervises `opencode serve`.
set -Eeuo pipefail

mkdir -p \
  "${XDG_DATA_HOME:-/home/opencode/.local/share}/opencode" \
  "${XDG_CONFIG_HOME:-/home/opencode/.config}/opencode" \
  "${XDG_CACHE_HOME:-/home/opencode/.cache}/opencode" \
  "${XDG_STATE_HOME:-/home/opencode/.local/state}/opencode"

exec node /opt/opencode/opencode-agent.mjs
