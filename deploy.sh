#!/usr/bin/env bash
# Build, start, or stop the Docker Compose deployment from this checkout.
set -euo pipefail

usage() {
  printf 'Usage: ./deploy.sh [--stop] [--help]\n\nBuild and start the Docker Compose stack. Requires Docker, the Compose plugin,\nand a configured .env file (copy .env.example and replace DISCOVERY_TOKEN).\n\n  --stop  Stop and remove the stack containers, preserving named volumes.\n  --help  Show this help.\n'
}

STOP=0
for arg in "$@"; do
  case "$arg" in
    --stop) STOP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$STOP" = "0" ] && [ ! -f .env ]; then
  fail 'Missing .env. Copy .env.example to .env and replace DISCOVERY_TOKEN before running ./deploy.sh.'
fi
command -v docker >/dev/null 2>&1 || fail 'Docker is not installed or is not on PATH. Install Docker and its Compose plugin.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose is unavailable. Install the Docker Compose plugin.'
docker info >/dev/null 2>&1 || fail 'Cannot access the Docker daemon. Start Docker and check your Docker permissions.'

if [ "$STOP" = "1" ]; then
  printf '[deploy] Stopping services...\n'
  docker compose down
  printf '[deploy] Services stopped. Named volumes preserved.\n'
  exit 0
fi

printf '[deploy] Validating Docker Compose configuration...\n'
docker compose config --quiet
printf '[deploy] Building and starting services...\n'
docker compose up -d --build
docker compose ps
printf '[deploy] Services started. Follow logs with: docker compose logs -f\n'
