# opencode-free-bridge

Self-maintaining **OpenAI-compatible HTTP API** for the free models exposed by
the [`opencode`](https://github.com/sst/opencode) CLI. Zero runtime
dependencies (Node builtins only). Runs as a systemd service on bare metal or
as a two-container Docker Compose stack.

It translates the industry-standard OpenAI Chat Completions API onto the local
`opencode serve` REST API (`/session`, `/session/{id}/message`, ...), and it
keeps itself up to date: free models are discovered from
`opencode models opencode`, verified, hot-deployed into the running bridge,
and rolled back automatically if a deployment breaks anything.

```
┌──────────────┐      /v1/chat/completions       ┌──────────────────┐   opencode /session/{id}/message   ┌──────────────────┐
│  any client  │ ──────────────────────────────▶ │      bridge      │ ─────────────────────────────────▶ │  opencode serve  │
│  (curl, SDK) │ ◀──── OpenAI-shaped JSON/SSE ── │  :5577 loopback  │ ◀──────── model response ───────── │  :4577 loopback  │
└──────────────┘                                 └──────────────────┘                                    └──────────────────┘
                                                          │
                                              discovers + verifies + deploys
                                                          │
                                                  ┌───────┴────────┐
                                                  │ opencode models │  →  config/models.json
                                                  └────────────────┘
```

## What it does

- `GET /v1/models` — every currently available free model (live registry)
- `GET /v1/models/{id}` — one model, 404 for unknown ids
- `POST /v1/chat/completions` — non-streaming and `stream: true` (SSE)
- `GET /health` — rich status (upstream, sync state, registry hash)
- `GET /health/ready` — readiness probe (503 until registry + upstream ready)
- `GET /healthz` — plain 200 liveness probe (compat)
- OpenAI Python / Node / curl clients work unchanged
- **Self-maintaining model registry** — new free models show up automatically
- **Safe deploys** — atomic writes, backups, post-deploy HTTP verification,
  automatic rollback, last-known-good fallback chain
- **Docker Compose deployment** — bridge + `opencode serve` side by side,
  free-model discovery over an internal authenticated agent
- **Optional hardening** — bearer API key, per-IP rate limiting, CORS
  allowlist, body-size cap (all off/unlimited by default)

## How auto-maintenance works

While the bridge is running, a background loop (default: every 60 minutes)
runs the full sync pipeline:

1. **Discover** — `opencode models opencode --verbose` is parsed into id,
   context window, max output, cost and status.
2. **Classify** — a model is free when it is zero-cost **and** matches one of:
   `-free` suffix, a known-free id (`big-pickle`), or the admin include list
   in `config/exclusions.json`. Anything with a non-zero cost is rejected
   outright. `nemotron-*` is excluded by default (those models are known to
   crash/hang opencode sessions).
3. **Verify** — new candidates are probed against the live upstream (real
   1-token inference only when `MODEL_VALIDATE_INFERENCE=true`; otherwise a
   session-create probe).
4. **Deploy** — `config/models.json` is updated atomically. A timestamped
   backup lands in `backups/`; the bridge's file watcher (and a polling
   fallback) hot-reloads the registry within milliseconds — no restart.
5. **Confirm** — the deployer polls `GET /v1/models` + `GET /health` until the
   new registry is live. Any failure → automatic restore of the previous
   registry, in memory and on disk (exit code 1 for the CLI).
6. **Serve** — requests keep working from the last known-good registry at all
   times: `config/models.json` → its `.bak` → `config/models.default.json` →
   whatever is already in memory.

Parents that prefer scheduled syncs can set `MODEL_AUTO_SYNC=false` and enable
`opencode-free-bridge-sync.timer` instead (see systemd below).

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/raksix/opencode-free-bridge.git
cd opencode-free-bridge
cp .env.example .env
# Edit .env: replace DISCOVERY_TOKEN=change-me; optionally set BRIDGE_API_KEY.
./deploy.sh
curl -s http://127.0.0.1:5577/health | jq
```

Requires Docker and the Docker Compose plugin. `deploy.sh` requires an existing
`.env`, preserves its contents, and builds and starts the stack in the background.
Run it again after updating the checkout to rebuild and deploy the latest code.
The script reports startup status; use `/health` to check bridge liveness.
Run `./deploy.sh --stop` to stop and remove the stack containers while preserving
named volumes. Stopping also works if `.env` is missing.

Two containers come up: `opencode-server` (runs `opencode serve` plus an
internal authenticated discovery agent) and `opencode-bridge` (the HTTP API,
published on `127.0.0.1:5577` by default). Both have liveness healthchecks;
the bridge waits for the server to be healthy before starting. Model registry,
state, backups and opencode credentials all live in named volumes, so
`docker compose down` + `up` (or image upgrades) keep them.

If your opencode account needs a login, see
[OpenCode authentication](#opencode-authentication).

### Bare metal (systemd)

```bash
git clone https://github.com/raksix/opencode-free-bridge.git
cd opencode-free-bridge
sudo ./scripts/install.sh
```

`install.sh` detects the service user, resolves the `node`/`bun` runtime and
the `opencode` binary (including `~/.opencode/bin`), installs and starts:

- `opencode-serve.service` — `opencode serve` on `127.0.0.1:4577`
- `opencode-free-bridge.service` — the bridge on `127.0.0.1:5577`
- `/usr/local/bin/opencode-free-bridge` — management launcher

It also creates `.env` from `.env.example` and waits for
`GET /health` before declaring success. Both units are enabled for boot.

Manual start (without systemd):

```bash
opencode-free-bridge start    # starts opencode serve + bridge, waits for health
opencode-free-bridge status   # ports, upstream version, model count, last sync
opencode-free-bridge logs     # tail both logs
opencode-free-bridge stop
```

When the systemd service is active, the launcher's `start`/`stop`/`restart`
step aside and point you at `systemctl` instead of fighting over the ports.

## CLI

```
opencode-free-bridge status                  # bridge + upstream health summary
opencode-free-bridge health [--json]         # liveness/readiness, exit 0/1 for scripts
opencode-free-bridge health --ready          # exit 1 until models + upstream are ready
opencode-free-bridge models                  # registry table (id, ctx, max output, status)
opencode-free-bridge models list --json      # machine-readable registry
opencode-free-bridge models sync             # discover → verify → deploy now
opencode-free-bridge models status           # sync state, lock, last run
opencode-free-bridge models verify <id|all>  # re-probe one model or all
opencode-free-bridge models exclude <id|pattern> [--reason "..."]
opencode-free-bridge models include <id|pattern>
opencode-free-bridge config verify [--online] # validate registry/exclusions/metadata files
opencode-free-bridge reload                  # SIGHUP the bridge (reload registry)
opencode-free-bridge restart                 # graceful SIGTERM (Docker restarts it)
opencode-free-bridge logs [-n N]             # tail bridge + opencode logs
opencode-free-bridge version
```

`models sync` runs outside the bridge under a cross-process lock, so CLI syncs
and the in-server auto-sync never race. Exit code is `1` when a run fails or
rolls back, `0` for `ok`/`unchanged`. `health --quiet` and
`config verify` are designed for scripts and Docker healthchecks.

Inside a container, use the short alias (kept in sync with the CLI):

```bash
docker compose exec opencode-bridge bridge-cli status
docker compose exec opencode-bridge bridge-cli models sync
```

## Docker

### Services

| Service | Image | Role | Network |
| --- | --- | --- | --- |
| `opencode-server` | `Dockerfile.opencode` | `opencode serve` on `4577` + discovery agent on `4578` | internal only |
| `opencode-bridge` | `Dockerfile.bridge` | the OpenAI-compatible API on `5577` | published to `127.0.0.1:5577` |

Because the bridge cannot execute the `opencode` CLI from its own container,
discovery goes through a small authenticated HTTP agent that runs next to
`opencode serve`. The agent executes `opencode models opencode [--verbose]`
and returns raw stdout; parsing and free/paid classification still happen in
`lib/discovery.mjs` inside the bridge. The agent is the only component that
knows `DISCOVERY_TOKEN`; it is never exposed outside the Compose network.

Both containers run as non-root, drop nothing else, and the bridge's root
filesystem is read-only (`tmpfs` for `/tmp`). Writable state lives in named
volumes:

| Volume | Mount | Contents |
| --- | --- | --- |
| `bridge-config` | `/app/config` | `models.json`, `exclusions.json`, `metadata.json` (seeded on first boot) |
| `bridge-state` | `/app/state` | verification state, sync lock |
| `bridge-backups` | `/app/backups` | timestamped registry backups |
| `bridge-logs` | `/app/logs` | log file (only if you set `LOG_FILE` to a path) |
| `bridge-run` | `/app/run` | `bridge.pid` |
| `opencode-data` | `/home/opencode/.local/share/opencode` | opencode credentials/auth + DB |
| `opencode-config` | `/home/opencode/.config/opencode` | `opencode.jsonc` |
| `opencode-cache` / `opencode-state` | `~/.cache/opencode`, `~/.local/state/opencode` | caches and logs |

### Configuration

Everything is driven by `.env` (see `.env.example`; `.env` is excluded from
Docker builds and never baked into images):

```bash
cp .env.example .env
# Recommended in Docker:
BRIDGE_BIND=127.0.0.1          # keep the API loopback-only on the host
BRIDGE_PORT=5577
BRIDGE_API_KEY=                # leave empty for local-only use
DISCOVERY_TOKEN=change-me      # replace; shared secret for the discovery agent
OPENCODE_VERSION=1.19.3        # opencode CLI version installed in the image
IMAGE_TAG=latest
```

Inside Compose, `ALLOW_NON_LOOPBACK=true` is set for the bridge because
clients arrive with the Docker gateway address — the loopback guarantee is
provided by the host port binding (`BRIDGE_BIND=127.0.0.1`). If you change
`BRIDGE_BIND` to a public address, set `BRIDGE_API_KEY` too; the config warns
when it is missing.

### Management

```bash
docker compose ps                       # container state
docker compose logs -f opencode-bridge  # bridge logs (stdout)
docker compose exec opencode-bridge bridge-cli health
docker compose exec opencode-bridge bridge-cli models
docker compose exec opencode-bridge bridge-cli models sync
docker compose exec opencode-bridge bridge-cli config verify
docker compose exec opencode-bridge bridge-cli restart   # SIGTERM; restart policy revives
docker compose down                     # keeps volumes (registry + auth persist)
docker compose up -d --build            # upgrade to new code/images
```

Healthchecks are liveness-only (`bridge-cli health --quiet` and the agent's
`healthcheck` mode), so a temporary provider outage does not cause container
restarts. Orchestrators that gate traffic should poll `/health/ready`
instead, which requires a non-empty registry and a connected upstream.

### OpenCode authentication

If `opencode` inside the container has no credentials, models may be missing
or inference will fail. Migrate an existing host login (recommended):

```bash
./scripts/migrate-auth.sh                 # copies ~/.local/share/opencode/auth.json into the volume
./scripts/migrate-auth.sh --with-config   # also copies ~/.config/opencode
./scripts/migrate-auth.sh --force         # overwrite an existing container auth.json
```

The script never prints secret material, refuses to overwrite without
`--force`, and verifies with `docker compose exec opencode-server opencode
models opencode`. Without a host login, authenticate interactively:

```bash
docker compose exec opencode-server opencode auth login
```

## Model registry

The live registry lives in `config/models.json`:

```json
{
  "generation": 7,
  "updatedAt": "2026-10-18T05:16:39.218Z",
  "lastSync": { "at": "…", "status": "unchanged", "added": [], "removed": [] },
  "models": [
    {
      "id": "big-pickle",
      "name": "Big Pickle",
      "context": 200000,
      "output": 32000,
      "status": "discovered",
      "freeReason": "known-free",
      "addedAt": "…",
      "verifiedAt": "…",
      "failCount": 0
    }
  ]
}
```

Current defaults (auto-updated as models come and go):

| ID                       | Context | Max output | Notes        |
| ------------------------ | ------- | ---------- | ------------ |
| `beam-free`              | 1.0M    | 128K       |              |
| `big-pickle`             | 200K    | 32K        | known free   |
| `deepseek-v4.1-flash-free` | 200K  | 32K        |              |
| `glm-5.3-flash-free`     | 200K    | 32K        |              |
| `longcat-2.5-preview-free` | 1.0M  | 128K       |              |
| `mimo-v2.6-flash-free`   | 200K    | 32K        |              |
| `space-bunny-free`       | 1.0M    | 512K       |              |

Excluded by default: `nemotron-*` (crash/hang upstream sessions).

### Exclusions and includes

`config/exclusions.json` is the persistent admin list (the CLI edits it for
you):

```json
{
  "exclude": ["nemotron-*"],
  "include": [],
  "reasons": { "nemotron-*": "nemotron models are known to crash or hang opencode sessions" }
}
```

Patterns support `*`, `?` and `re:` regex. Exclusions always win over
includes. `models exclude`/`include` update the file, sync immediately, and
the bridge hot-reloads.

## Configuration

All settings are environment variables (see `.env.example`). Real environment
variables override `.env`. **No API key is required.**

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5577` | Bridge listen port (loopback only) |
| `HOST` | `127.0.0.1` | Listen address (containers use `0.0.0.0` + port binding) |
| `ALLOW_NON_LOOPBACK` | `false` | Accept non-loopback clients (needed in Docker; warns without an API key) |
| `BRIDGE_API_KEY` | *(unset)* | Require `Authorization: Bearer <key>` on `/v1/*` (health stays open) |
| `BRIDGE_API_KEY_FILE` | *(unset)* | Read the API key from a Docker secret file instead |
| `RATE_LIMIT_RPM` | `120` | Per-IP requests/minute on `/v1/*`; `0` disables |
| `REQUEST_BODY_LIMIT_BYTES` | `10485760` | Max request body size (413 beyond it) |
| `CORS_ALLOWED_ORIGINS` | *(empty)* | Comma-separated origin allowlist; empty = no CORS headers |
| `OPENCODE_UPSTREAM` | `http://127.0.0.1:4577` | `opencode serve` base URL |
| `OPENCODE_BIN` | `opencode` | CLI used for discovery (auto-filled by installer) |
| `DISCOVERY_URL` | *(unset)* | Discover through an internal agent instead of the local CLI (Docker) |
| `DISCOVERY_TOKEN` | *(unset)* | Bearer token for the discovery agent (`DISCOVERY_TOKEN_FILE` also supported) |
| `OPENCODE_PROVIDER` | `opencode` | Provider whose models are synced |
| `OPENCODE_AGENT` | `general` | Agent used for upstream messages |
| `MODEL_AUTO_SYNC` | `true` | In-server periodic sync |
| `MODEL_SYNC_INTERVAL_MINUTES` | `60` | Sync period |
| `MODEL_SYNC_ON_STARTUP` | `true` | Run a sync right after boot |
| `MODEL_AUTO_DEPLOY` | `true` | Deploy discovered models automatically |
| `MODEL_HEALTH_CHECK` | `true` | Post-deploy HTTP verification |
| `MODEL_EXCLUDE` | *(empty)* | Extra exclude patterns (persistent list lives in `config/exclusions.json`) |
| `MODEL_VALIDATE_INFERENCE` | `false` | 1-token real inference probe for new models |
| `MODEL_DISCOVERY_TIMEOUT_MS` | `60000` | Discovery subprocess timeout |
| `MODEL_VERIFY_TIMEOUT_MS` | `60000` | Per-model verification timeout |
| `MODEL_VERIFY_CONCURRENCY` / `MODEL_VERIFY_MAX_PER_RUN` | `1` / `3` | Verification throttle |
| `MODEL_VERIFY_RETRY_HOURS` | `12` | Re-verification window for failed models |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Chat request timeout |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `10000` | Upstream connect timeout |
| `UPSTREAM_RETRIES` / `UPSTREAM_RETRY_BASE_MS` | `2` / `500` | Bounded retries (fresh session each try), exponential backoff |
| `HEALTH_UPSTREAM_TIMEOUT_MS` / `HEALTH_CACHE_MS` | `2000` / `10000` | `/health` upstream probe |
| `DEPLOY_VERIFY_TIMEOUT_MS` / `DEPLOY_VERIFY_STABLE_MS` | `10000` / `20000` | Deploy verification window |
| `SYNC_LOCK_STALE_MS` | `600000` | Cross-process sync lock staleness |
| `SESSION_MODE` | `per-request` | `per-request` (fresh session + DELETE cleanup) or `shared` |
| `INCLUDE_HISTORY` | `true` | Send prior turns with each request |
| `BACKUP_KEEP` | `20` | Registry backups to retain |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `LOG_FILE` | `logs/bridge.log` | Set `-` to log to stdout (containers do this) |

## Usage

### curl

```bash
curl -s http://127.0.0.1:5577/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "big-pickle",
    "messages": [{"role":"user","content":"2+2=? Number only."}],
    "max_tokens": 20
  }'
```

Streaming (SSE):

```bash
curl -N http://127.0.0.1:5577/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:5577/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Say hi in one word."}],
)
print(resp.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "yes or no?"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
print()
```

### OpenAI Node SDK

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://127.0.0.1:5577/v1",
  apiKey: "not-needed",
});
const r = await client.chat.completions.create({
  model: "big-pickle",
  messages: [{ role: "user", content: "hello" }],
});
console.log(r.choices[0].message.content);
```

## systemd

`sudo ./scripts/install.sh` handles everything. For manual control:

```bash
sudo systemctl status opencode-serve.service opencode-free-bridge.service
sudo systemctl restart opencode-free-bridge.service
journalctl -u opencode-free-bridge -f
```

Scheduled-sync variant (only if you set `MODEL_AUTO_SYNC=false`):

```bash
sudo ./scripts/install.sh --with-timer
sudo systemctl list-timers opencode-free-bridge-sync.timer
```

## Upgrading

```bash
sudo ./scripts/upgrade.sh                 # git pull → tests → restart → health check
sudo ./scripts/upgrade.sh --auto-rollback # also git-revert if the new code fails to come up
```

The registry (`config/models.json`, backups, state) is untouched by upgrades.

## Health

`GET /health` returns the full picture:

```json
{
  "status": "ok",
  "ok": true,
  "bridge": { "ok": true, "version": "2.1.0", "pid": 123, "uptimeSeconds": 42 },
  "upstream": "connected",
  "upstreamVersion": "1.19.0",
  "modelCount": 7,
  "registryHash": "fb1a1ea4ce8fe629",
  "registry": { "ok": true, "source": "config/models.json", "generation": 3, "models": 7 },
  "discovery": { "mode": "agent" },
  "modelSync": "enabled",
  "lastSync": { "status": "unchanged", "...": "..." }
}
```

`status` flips to `degraded` (HTTP 200 for probes, details in the body) when
the upstream is unreachable; `GET /healthz` stays a plain 200 for dumb
liveness checks. `GET /health/ready` returns `200 {"ready": true}` only when
the bridge is up, the registry has at least one model and the upstream is
connected — otherwise `503`. Docker healthchecks use liveness; use
`/health/ready` when routing traffic.

## Errors

OpenAI-shaped error objects with useful messages:

- `404` — unknown model (not in the live registry) or unknown route
- `502` — upstream unreachable/failed
- `504` — upstream timeout
- `500` — upstream error (the upstream `ref` id is extracted and logged)
- `401` — missing/wrong `Authorization: Bearer <BRIDGE_API_KEY>` on `/v1/*`
- `429` — rate limit exceeded (`Retry-After` header included)
- `413` — request body larger than `REQUEST_BODY_LIMIT_BYTES`
- `403` — non-loopback client

## Security

- Defaults to `127.0.0.1`; non-loopback connections are rejected with 403
  unless `ALLOW_NON_LOOPBACK=true`.
- With no API key, auth is implicit in the loopback-only bind. In Docker the
  containers bind `0.0.0.0` and the host port binding keeps the same
  guarantee; publishing to a public address without `BRIDGE_API_KEY` logs a
  config warning.
- Optional `BRIDGE_API_KEY` (constant-time compared) protects all `/v1/*`
  routes. `/health`, `/healthz`, `/health/ready` stay open for healthchecks
  but never include secrets.
- Per-IP token-bucket rate limiting (`RATE_LIMIT_RPM`, default 120) and a
  request body cap (default 10 MB) bound resource use; CORS is off unless
  origins are explicitly allowlisted.
- Secrets can come from files (`BRIDGE_API_KEY_FILE`, `DISCOVERY_TOKEN_FILE`)
  for Docker/Swarm secrets; `.env` is excluded from build contexts.
- No filesystem access in the request path, no shell exec beyond model
  discovery (`opencode models` locally, the token-protected agent in Docker),
  no env passthrough to clients.

## Architecture

| File | Purpose |
| --- | --- |
| `server.mjs` | HTTP server: OpenAI endpoints, per-request upstream sessions, retries, SIGHUP reload, sync loop |
| `cli.mjs` | Management CLI (`status`, `models …`, `reload`, `logs`, `version`) |
| `lib/discovery.mjs` | Parses `opencode models … --verbose`, free/paid classification |
| `lib/sync.mjs` | Sync orchestration, deploy verification, merge logic |
| `lib/registry.mjs` | Registry persistence, atomic writes, watcher, fallbacks, rollback |
| `lib/verify.mjs` | Model verification probes |
| `lib/upstream.mjs` | Upstream HTTP client, retries, error mapping |
| `lib/config.mjs` · `lib/logger.mjs` · `lib/fsutil.mjs` · `lib/opencode-client.mjs` | Config, logging, atomic FS helpers, upstream session client |
| `lib/agent-discovery.mjs` | Discovery runner that talks to the internal agent (Docker) |
| `docker/opencode-agent.mjs` | Internal authenticated agent: CLI proxy + `opencode serve` supervisor |
| `Dockerfile.bridge` · `Dockerfile.opencode` · `docker-compose.yml` | Two-container deployment |
| `docker/bridge-entrypoint.sh` · `docker/opencode-entrypoint.sh` | Volume seeding, XDG setup, exec |
| `bridge-cli` | Short CLI alias used inside the bridge container |
| `scripts/migrate-auth.sh` | One-shot host → volume opencode auth migration |
| `scripts/opencode-free-bridge` | Launcher (standalone mode) + systemd-aware hints |
| `scripts/opencode-*.service` · `scripts/opencode-free-bridge-sync.timer` | systemd units |
| `scripts/install.sh` · `scripts/upgrade.sh` | Installer and safe upgrader |
| `config/models.json` · `config/models.default.json` · `config/exclusions.json` | Registry, shipped seed, exclusions |
| `backups/` · `state/` · `logs/` · `run/` | Backups, sync/verify state, logs, pidfiles (gitignored) |

Requests use a fresh upstream session by default (`SESSION_MODE=per-request`)
that is deleted after the response, so no state leaks between clients.

## Tests

```bash
npm test                              # 117 tests: discovery, registry, sync, server, security, cli, agent
RUN_DOCKER_TESTS=1 npm test           # + compose config validation & packaging invariants
RUN_DOCKER_TESTS=1 RUN_DOCKER_FULL=1 npm test   # + full two-container boot & health
```

Tests never touch real quota: the opencode CLI is mocked and upstream calls
are stubbed unless a test explicitly targets the live integration path. The
discovery-agent tests spawn the real agent with a mocked CLI binary.

## Troubleshooting

- **`models sync` says "no opencode binary"** — set `OPENCODE_BIN` to the
  absolute path (e.g. `/home/you/.opencode/bin/opencode`) in `.env`.
- **New model appears in `opencode models` but not in `/v1/models`** — check
  `config/exclusions.json`, then `opencode-free-bridge models status` and the
  bridge log (`logs/bridge.log`); the sync loop logs `found/free/excluded`.
- **A model 500s upstream** — the error is logged with the upstream `ref`;
  `opencode-free-bridge models exclude <id> --reason "…"` removes it and
  hot-reloads instantly.
- **Bridge degraded after reboot** — `opencode-serve.service` may lack the
  CLI path; re-run `sudo ./scripts/install.sh` (it writes `OPENCODE_BIN`).
- **Docker: `/v1/models` is empty** — the container has no opencode
  credentials. Run `./scripts/migrate-auth.sh` or
  `docker compose exec opencode-server opencode auth login`, then
  `docker compose exec opencode-bridge bridge-cli models sync`.
- **Docker: 403 on every request** — `ALLOW_NON_LOOPBACK` is not set for the
  bridge (Compose sets it); for manual runs add it, or set
  `BRIDGE_API_KEY` and expose through `BRIDGE_BIND`.
- **Docker: discovery fails with 401** — `DISCOVERY_TOKEN` differs between
  containers; recreate both: `docker compose up -d --force-recreate`.
- **Docker: config invalid after hand-editing** — models.json is quarantined
  on boot instead of crashing: `bridge-cli config verify` shows the problem,
  `.corrupt.<timestamp>` files sit next to the seeded default.

## License

MIT
