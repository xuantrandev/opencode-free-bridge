// Shared test helpers: temp environments, mocked `opencode` CLI, and a mocked
// opencode-serve upstream. No real free-model quota is ever consumed.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../lib/config.mjs';
import { ModelRegistry } from '../lib/registry.mjs';

export async function makeTempEnv(env = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ofb-test-'));
  for (const sub of ['config', 'state', 'logs', 'backups', 'run']) {
    await fsp.mkdir(path.join(dir, sub), { recursive: true });
  }
  // PORT=0 keeps deploy verification pointed at a dead port no matter what
  // is running on the developer's machine (e.g. a real bridge on 5577).
  const config = loadConfig({ root: dir, env: { PORT: '0', ...env } });
  return {
    dir,
    config,
    async cleanup() {
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

export function makeModelEntry(id, extra = {}) {
  return {
    id,
    context: null,
    output: null,
    status: 'discovered',
    addedAt: '2026-01-01T00:00:00.000Z',
    verifiedAt: null,
    failCount: 0,
    freeReason: 'suffix',
    name: null,
    ...extra,
  };
}

export function writeRegistry(dir, models, extra = {}) {
  const file = path.join(dir, 'config', 'models.json');
  const value = {
    version: 1,
    models: models.map((m) => (typeof m === 'string' ? makeModelEntry(m) : m)),
    lastUpdated: null,
    lastSync: null,
    lastSyncStatus: null,
    lastDeploy: null,
    source: 'opencode models opencode',
    generation: 1,
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

export function writeExclusions(dir, { exclude = [], include = [], reasons = {} } = {}) {
  const file = path.join(dir, 'config', 'exclusions.json');
  fs.writeFileSync(file, JSON.stringify({ exclude, include, reasons }, null, 2));
  return file;
}

export function writeMetadata(dir, metadata) {
  const file = path.join(dir, 'config', 'metadata.json');
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2));
  return file;
}

export function readRegistry(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config', 'models.json'), 'utf8'));
}

export function makeRegistry(dir, logger = null) {
  const config = loadConfig({ root: dir, env: {} });
  const registry = new ModelRegistry({ paths: config.paths, logger });
  registry.load();
  return { registry, config };
}

// Extensionless file (no package.json nearby), so CommonJS on purpose.
const MOCK_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const specPath = process.env.MOCK_OPENCODE_SPEC || '__MOCK_SPEC_PATH__';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const delay = Number(spec.delayMs || 0);
const finish = () => {
  if (verbose) {
    if (spec.failVerbose) { process.stderr.write(spec.verboseStderr || 'mock verbose failure\\n'); process.exitCode = spec.verboseExitCode || 1; return; }
    if (spec.verboseRaw !== undefined) { process.stdout.write(spec.verboseRaw); return; }
    for (const id of spec.models || []) {
      process.stdout.write(id + '\\n');
      const meta = (spec.verbose || {})[id];
      if (meta) process.stdout.write(JSON.stringify(meta, null, 2) + '\\n');
    }
    return;
  }
  if (spec.failPlain) { process.stderr.write(spec.plainStderr || 'mock plain failure\\n'); process.exitCode = spec.exitCode || 1; return; }
  if (spec.rawText !== undefined) { process.stdout.write(spec.rawText); return; }
  for (const id of spec.models || []) process.stdout.write(id + '\\n');
};
if (delay > 0) setTimeout(finish, delay); else finish();
`;

/**
 * Create an executable mock `opencode` CLI. Returns { bin, setSpec }.
 * The mock repeats the given output for `models` / `models --verbose`.
 */
export async function mockOpencode(dir, initialSpec = {}) {
  const binDir = path.join(dir, 'mockbin');
  await fsp.mkdir(binDir, { recursive: true });
  const bin = path.join(binDir, 'opencode');
  const specFile = path.join(binDir, 'spec.json');
  await fsp.writeFile(bin, MOCK_SCRIPT.replace('__MOCK_SPEC_PATH__', specFile), { mode: 0o755 });
  const setSpec = (spec) => fsp.writeFile(specFile, JSON.stringify(spec, null, 2));
  await setSpec(initialSpec);
  return { bin, specFile, setSpec };
}

export function verboseMeta({ context = null, output = null, costInput = 0, costOutput = 0, status = 'active', name = null } = {}) {
  return {
    id: name,
    name,
    status,
    limit: { context, output },
    cost: { input: costInput, output: costOutput },
  };
}

/**
 * Mock opencode-serve upstream.
 *   options.health        - fn() -> {status, body, delayMs} | 'hang' (default 200 healthy)
 *   options.session       - fn() -> {status, body} (default 200 {id:'ses_mock'})
 *   options.message       - fn({model, body, attempt}) -> {status, body, delayMs} | 'hang'
 *   options.messageQueue  - { [model]: [{status,body}, ...] } consumed per model
 *   options.deleteStatus  - default 200
 */
export async function startMockUpstream(options = {}) {
  const state = {
    calls: [],
    sessions: new Set(),
    sessionSeq: 0,
    messageCounts: {},
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { __unparsed: raw }; }
    state.calls.push({ method: req.method, url: req.url, body });
    const send = (status, obj, delayMs = 0) => {
      const payload = typeof obj === 'string' ? obj : JSON.stringify(obj ?? {});
      const respond = () => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload);
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    };
    const hang = () => { /* never respond */ };

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/global/health') {
      const h = options.health ? await options.health() : { status: 200, body: { healthy: true, version: 'mock-1.0' } };
      if (h === 'hang') return hang();
      return send(h.status ?? 200, h.body, h.delayMs ?? 0);
    }
    if (req.method === 'GET' && url.pathname === '/config') {
      return send(200, { model: 'mock' });
    }
    if (req.method === 'POST' && url.pathname === '/session') {
      const s = options.session ? await options.session() : { status: 200 };
      if (s === 'hang') return hang();
      const id = `ses_mock_${++state.sessionSeq}`;
      state.sessions.add(id);
      return send(s.status ?? 200, s.body ?? { id });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/session/')) {
      const id = url.pathname.split('/').pop();
      state.sessions.delete(id);
      return send(options.deleteStatus ?? 200, {});
    }
    const messageMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === 'POST' && messageMatch) {
      const model = body?.model?.modelID ?? 'unknown';
      const sessionId = messageMatch[1];
      state.messageCounts[model] = (state.messageCounts[model] || 0) + 1;
      const count = state.messageCounts[model];
      let spec = null;
      if (options.messageQueue?.[model]?.length) {
        const queue = options.messageQueue[model];
        spec = queue.length > 1 ? queue.shift() : queue[0];
      } else if (options.message) {
        spec = await options.message({ model, body, attempt: count, sessionId });
      } else {
        spec = { status: 200 };
      }
      if (spec === 'hang') return hang();
      const status = spec.status ?? 200;
      const payload = spec.body ?? {
        info: { tokens: { input: 11, output: 7, total: 18 }, finish: 'stop' },
        parts: [{ type: 'text', text: `echo:${model}` }],
      };
      return send(status, payload, spec.delayMs ?? 0);
    }
    return send(404, { name: 'NotFound', data: { message: `no route ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export function httpJson(url, { method = 'GET', body = undefined, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.setHeader?.('Content-Type', 'application/json');
      req.write(payload);
    }
    req.end();
  });
}

export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`);
}

export async function readSse(response) {
  const text = await response.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .map((d) => (d === '[DONE]' ? '[DONE]' : JSON.parse(d)));
}
