# Repository Guidelines

## Project Structure & Module Organization

`server.mjs` implements the OpenAI-compatible HTTP bridge; `cli.mjs` and `bridge-cli` provide management commands. Shared modules in `lib/` handle configuration, discovery, verification, registry persistence, and upstream sessions. `config/` contains model registries, defaults, exclusions, and metadata. Tests live in `test/`, with reusable mocks in `test/helpers.mjs`. Docker entrypoints and the discovery agent live in `docker/`; deployment files sit at the repository root. `scripts/` contains installers, launchers, and systemd units. Runtime directories (`backups/`, `state/`, `logs/`, `run/`) are gitignored.

## Build, Test, and Development Commands

Use Node.js 20 or newer. The project has no npm dependencies or compilation step.

- `npm start`: run the bridge; local operation requires an accessible `opencode serve` upstream (default `http://127.0.0.1:4577`).
- `node cli.mjs status`: inspect bridge and upstream status.
- `npm run check`: syntax-check the listed JavaScript entrypoints and modules.
- `npm test`: run the Node.js test suite; Docker tests skip by default.
- `node --test test/registry.test.mjs`: run a focused test file.
- `npm run docker:config`: validate the Compose configuration.
- `npm run docker:up`: build images and start both services; `npm run docker:down` stops them.

## Coding Style & Naming Conventions

Follow existing ES module conventions: `.mjs` files, `node:` imports for built-ins, two-space indentation, single quotes, and semicolons. Use camelCase for functions and variables, PascalCase for classes, and uppercase snake case for environment variables. Prefer descriptive, hyphenated module filenames. No formatter or linter is configured; match surrounding code and run `npm run check`.

## Testing Guidelines

Use `node:test` and `node:assert/strict`, naming files `test/<feature>.test.mjs`. Reuse temporary environments and mocked CLI/upstream helpers; clean resources with `t.after()`. Add regression tests for behavior changes. No coverage threshold is configured. Run `RUN_DOCKER_TESTS=1 npm test` for packaging checks; additionally set `RUN_DOCKER_FULL=1` for the full stack test, which removes its Compose volumes during cleanup.

## Commit & Pull Request Guidelines

History uses prefixes such as `feat:`, `fix:`, `refactor:`, and `docs:`. Follow that pattern with a concise description. Pull requests should explain the behavior change, link relevant issues, list validation performed, and document configuration or deployment impacts.

## Security & Configuration

Copy `.env.example` to `.env` when needed; keep credentials out of commits. Preserve loopback defaults. Set `BRIDGE_API_KEY` when exposing the bridge and replace the example `DISCOVERY_TOKEN` for Docker deployments. Update `.env.example` and `README.md` when changing configuration.
