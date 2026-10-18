#!/usr/bin/env node
// Internal discovery agent + process supervisor for the opencode-server container.
//
// The bridge container cannot execute the `opencode` CLI inside this container,
// so this agent runs the CLI locally and exposes a tiny, token-protected HTTP
// API on the Docker-internal network only:
//
//   GET /health                                  cheap liveness + upstream probe
//   GET /models?provider=opencode[&verbose=1]    runs `opencode models <provider> [--verbose]`
//   GET /version                                 runs `opencode --version`
//
// It can also supervise `opencode serve` (AGENT_SUPERVISE=1, the default) with
// proper signal forwarding. If the serve process dies the agent exits, letting
// the Docker restart policy back off and restart the container.
//
// Zero dependencies (Node builtins only). Never exposes credentials: the agent
// only returns raw CLI stdout/stderr.

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

function intEnv(name, fallback) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function readSecret(value, file) {
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      log('error', `cannot read secret file ${file}: ${err?.code || err?.message}`);
      process.exit(1);
    }
  }
  return value ?? '';
}

const AGENT_HOST = env.AGENT_HOST || '0.0.0.0';
const AGENT_PORT = intEnv('AGENT_PORT', 4578);
const AGENT_TOKEN = readSecret(env.AGENT_TOKEN, env.AGENT_TOKEN_FILE);
const OPENCODE_BIN = env.OPENCODE_BIN || 'opencode';
const CMD_TIMEOUT_MS = intEnv('AGENT_CMD_TIMEOUT_MS', 60_000);
const MAX_CONCURRENCY = Math.max(1, intEnv('AGENT_MAX_CONCURRENCY', 2));
const MAX_OUTPUT_BYTES = intEnv('AGENT_MAX_OUTPUT_BYTES', 32 * 1024 * 1024);
const SUPERVISE = boolEnv('AGENT_SUPERVISE', true);
const SERVE_HOSTNAME = env.OPENCODE_SERVE_HOSTNAME || '0.0.0.0';
const SERVE_PORT = intEnv('OPENCODE_SERVE_PORT', 4577);
const UPSTREAM = env.OPENCODE_UPSTREAM || `http://127.0.0.1:${SERVE_PORT}`;
const UPSTREAM_TIMEOUT_MS = intEnv('AGENT_UPSTREAM_TIMEOUT_MS', 2000);
const REQUIRE_UPSTREAM_FOR_HEALTH = boolEnv('AGENT_REQUIRE_UPSTREAM_FOR_HEALTH', true);
const PROVIDER_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function log(level, msg, extra = '') {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [opencode-agent] ${msg}${extra ? ` ${extra}` : ''}`;
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authorized(req) {
  if (!AGENT_TOKEN) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return constantTimeEqual(match[1].trim(), AGENT_TOKEN);
}

// --------------------------------------------------------------- CLI runner

let inFlight = 0;

function runOpencode(args, { timeoutMs = CMD_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(OPENCODE_BIN, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT_BYTES,
      env: process.env,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started;
      if (error) {
        const timedOut = error.killed || error.signal === 'SIGKILL';
        resolve({
          ok: false,
          kind: timedOut ? 'timeout' : (error.code === 'ENOENT' ? 'spawn' : 'exit'),
          code: typeof error.code === 'number' ? error.code : null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          durationMs,
          error: timedOut
            ? `opencode ${args.join(' ')} timed out after ${timeoutMs}ms`
            : `opencode ${args.join(' ')} failed: ${error.message}`,
        });
        return;
      }
      resolve({ ok: true, kind: 'ok', code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), durationMs });
    });
  });
}

function upstreamAuthHeaders() {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = env.OPENCODE_SERVER_USERNAME || 'opencode';
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

async function probeUpstream({ timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const headers = upstreamAuthHeaders();
  for (const path of ['/global/health', '/config']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
    try {
      const res = await fetch(`${UPSTREAM}${path}`, { signal: controller.signal, redirect: 'manual', headers });
      if (res.ok) {
        let version = null;
        try {
          const body = await res.json();
          version = body?.version ?? null;
        } catch { /* non-json health */ }
        return { ok: true, status: res.status, path, latencyMs: Date.now() - started, version };
      }
      if (res.status === 404) continue;
      return { ok: false, status: res.status, path, latencyMs: Date.now() - started };
    } catch (err) {
      const aborted = err?.name === 'AbortError' || controller.signal.aborted;
      if (!aborted) return { ok: false, status: 0, path, latencyMs: Date.now() - started, error: err?.code || err?.message };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, path: null, latencyMs: Date.now() - started };
}

// --------------------------------------------------------------- supervisor

const supervisor = {
  enabled: SUPERVISE,
  pid: null,
  running: false,
  startedAt: null,
  child: null,
};

function startSupervisedServe() {
  if (!SUPERVISE) return;
  const args = ['serve', '--hostname', SERVE_HOSTNAME, '--port', String(SERVE_PORT)];
  log('info', `starting opencode serve`, `args=${args.join(' ')}`);
  const child = spawn(OPENCODE_BIN, args, { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  supervisor.child = child;
  supervisor.pid = child.pid ?? null;
  supervisor.running = true;
  supervisor.startedAt = new Date().toISOString();
  child.on('error', (err) => {
    log('error', `cannot start opencode serve: ${err?.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    supervisor.running = false;
    if (stopping) return;
    log('error', `opencode serve exited`, `code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    // Exit so the Docker restart policy handles backoff + restart.
    process.exit(typeof code === 'number' && code !== 0 ? code : 1);
  });
}

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', `shutting down`, `signal=${signal}`);
  const child = supervisor.child;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, 20_000);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 25_000).unref?.();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --------------------------------------------------------------- HTTP API

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://agent.local');
  } catch {
    return json(res, 400, { ok: false, error: 'bad request url' });
  }

  if (req.method !== 'GET') {
    return json(res, 405, { ok: false, error: 'method not allowed' });
  }

  if (url.pathname === '/health') {
    const upstream = SUPERVISE || REQUIRE_UPSTREAM_FOR_HEALTH ? await probeUpstream() : { ok: true, skipped: true };
    const ok = upstream.ok;
    return json(res, ok ? 200 : 503, {
      ok,
      agent: { ok: true, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) },
      upstream,
      supervisor: {
        enabled: supervisor.enabled,
        running: supervisor.running,
        pid: supervisor.pid,
        startedAt: supervisor.startedAt,
      },
      version: env.AGENT_VERSION || '1',
    });
  }

  if (!authorized(req)) {
    return json(res, 401, { ok: false, error: 'missing or invalid agent token' });
  }

  if (url.pathname === '/models') {
    const provider = url.searchParams.get('provider') || 'opencode';
    const verbose = ['1', 'true', 'yes'].includes(String(url.searchParams.get('verbose') ?? '').toLowerCase());
    if (!PROVIDER_RX.test(provider)) {
      return json(res, 400, { ok: false, kind: 'exit', error: 'invalid provider id' });
    }
    if (inFlight >= MAX_CONCURRENCY) {
      return json(res, 429, { ok: false, kind: 'busy', error: 'too many concurrent discovery commands' });
    }
    inFlight += 1;
    try {
      const args = ['models', provider, ...(verbose ? ['--verbose'] : [])];
      const result = await runOpencode(args);
      if (!result.ok) {
        log('warn', 'models command failed', `kind=${result.kind} code=${result.code}`);
        return json(res, result.kind === 'timeout' ? 504 : 502, {
          ok: false,
          kind: result.kind,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          error: result.error,
        });
      }
      return json(res, 200, {
        ok: true,
        code: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      });
    } finally {
      inFlight -= 1;
    }
  }

  if (url.pathname === '/version') {
    if (inFlight >= MAX_CONCURRENCY) {
      return json(res, 429, { ok: false, kind: 'busy', error: 'too many concurrent discovery commands' });
    }
    inFlight += 1;
    try {
      const result = await runOpencode(['--version']);
      return json(res, result.ok ? 200 : 502, {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      });
    } finally {
      inFlight -= 1;
    }
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

// --------------------------------------------------------------- main

async function healthcheckMode() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(env.AGENT_HEALTH_URL || `http://127.0.0.1:${AGENT_PORT}/health`, {
      signal: controller.signal,
      redirect: 'manual',
    });
    const body = await res.text();
    process.stdout.write(`${body}\n`);
    process.exitCode = res.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`healthcheck failed: ${err?.message || err}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === 'healthcheck') {
  await healthcheckMode();
  process.exit(process.exitCode ?? 0);
} else if (isMain) {
  if (!AGENT_TOKEN) log('warn', 'AGENT_TOKEN is empty — the discovery agent accepts unauthenticated requests on the internal network');
  if (SUPERVISE) startSupervisedServe();
  server.listen(AGENT_PORT, AGENT_HOST, () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : AGENT_PORT;
    log('info', `agent listening`, `url=http://${AGENT_HOST}:${port} upstream=${UPSTREAM} supervise=${SUPERVISE}`);
  });
  server.on('error', (err) => {
    log('error', `agent server error: ${err?.message}`);
    process.exit(1);
  });
}

export { runOpencode, probeUpstream, constantTimeEqual };
