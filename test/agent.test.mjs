// Tests for the internal discovery agent (docker/opencode-agent.mjs):
// CLI proxying, token auth, concurrency guard, upstream health and the
// opencode-serve supervisor. Runs the real agent as a subprocess; the
// `opencode` CLI and the upstream server are mocked (no quota consumed).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  httpJson, makeTempEnv, mockOpencode, startDiscoveryAgent, startMockUpstream, verboseMeta, waitFor,
} from './helpers.mjs';

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'opencode-agent.mjs');

async function setupAgent(t, {
  spec = { models: ['opencode/a-free'], verbose: { 'opencode/a-free': verboseMeta({ context: 1000, output: 100 }) } },
  token = 'test-token',
  upstream = null,
  extraEnv = {},
} = {}) {
  const temp = await makeTempEnv();
  t.after(() => temp.cleanup());
  const mock = await mockOpencode(temp.dir, spec);
  let up = null;
  const env = {
    OPENCODE_BIN: mock.bin,
    AGENT_TOKEN: token,
    AGENT_SUPERVISE: '0',
    ...extraEnv,
  };
  if (upstream === null) {
    up = await startMockUpstream();
    t.after(() => up.close());
    env.OPENCODE_UPSTREAM = up.url;
  } else if (typeof upstream === 'string') {
    env.OPENCODE_UPSTREAM = upstream;
  }
  const agent = await startDiscoveryAgent(env);
  t.after(() => agent.stop());
  return { temp, mock, up, agent, token };
}

test('agent /models proxies the CLI output and requires the bearer token', async (t) => {
  const { agent, token } = await setupAgent(t);

  const noAuth = await httpJson(`${agent.base}/models?provider=opencode`);
  assert.equal(noAuth.status, 401);

  const wrongAuth = await httpJson(`${agent.base}/models?provider=opencode`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrongAuth.status, 401);

  const ok = await httpJson(`${agent.base}/models?provider=opencode`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.stdout, /opencode\/a-free/);
  assert.equal(ok.json.code, 0);
});

test('agent /models?verbose=1 requests verbose CLI metadata', async (t) => {
  const { agent, token } = await setupAgent(t);
  const res = await httpJson(`${agent.base}/models?provider=opencode&verbose=1`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.match(res.json.stdout, /"limit"/);
  assert.match(res.json.stdout, /"cost"/);
});

test('agent rejects invalid providers and non-GET methods', async (t) => {
  const { agent, token } = await setupAgent(t);
  const bad = await httpJson(`${agent.base}/models?provider=${encodeURIComponent('bad provider!')}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bad.status, 400);

  const post = await httpJson(`${agent.base}/models`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: {} });
  assert.equal(post.status, 405);
});

test('agent maps CLI failures to 502 and timeouts to 504', async (t) => {
  const { agent, token, mock } = await setupAgent(t);
  await mock.setSpec({ failPlain: true, exitCode: 3 });
  const failed = await httpJson(`${agent.base}/models?provider=opencode`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.kind, 'exit');
});

test('agent enforces the concurrency guard', async (t) => {
  const { agent, token } = await setupAgent(t, {
    spec: { models: ['opencode/a-free'], delayMs: 400 },
    extraEnv: { AGENT_MAX_CONCURRENCY: '1' },
  });
  const headers = { Authorization: `Bearer ${token}` };
  const [first, second] = await Promise.all([
    httpJson(`${agent.base}/models?provider=opencode`, { headers }),
    httpJson(`${agent.base}/models?provider=opencode`, { headers }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 429]);
  const busy = [first, second].find((r) => r.status === 429);
  assert.equal(busy.json.kind, 'busy');
});

test('agent /version and /health reflect the upstream state', async (t) => {
  const { agent, token, up } = await setupAgent(t);
  const version = await httpJson(`${agent.base}/version`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(version.status, 200);
  assert.ok(version.json.stdout.trim().length > 0);

  const health = await httpJson(`${agent.base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.upstream.ok, true);
  assert.equal(health.json.supervisor.enabled, false);
  assert.equal(typeof up.url, 'string');
});

test('agent /health returns 503 when the upstream is unavailable', async (t) => {
  const { agent } = await setupAgent(t, { upstream: 'http://127.0.0.1:9' });
  const health = await httpJson(`${agent.base}/health`);
  assert.equal(health.status, 503);
  assert.equal(health.json.ok, false);
  assert.equal(health.json.upstream.ok, false);
});

function runHealthcheck(env, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [AGENT, 'healthcheck'], { env: { ...process.env, ...env }, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('agent healthcheck mode exits 0/1 for scripts and Docker healthchecks', async (t) => {
  const { agent } = await setupAgent(t);
  const healthy = await runHealthcheck({ AGENT_HEALTH_URL: `${agent.base}/health` });
  assert.equal(healthy.code, 0);
  const unhealthy = await runHealthcheck({ AGENT_HEALTH_URL: 'http://127.0.0.1:9/health', AGENT_PORT: '9' });
  assert.equal(unhealthy.code, 1);
});

test('agent supervises opencode serve and forwards SIGTERM', async (t) => {
  const temp = await makeTempEnv();
  t.after(() => temp.cleanup());
  const up = await startMockUpstream();
  t.after(() => up.close());

  const binDir = path.join(temp.dir, 'mockbin');
  await fsp.mkdir(binDir, { recursive: true });
  const bin = path.join(binDir, 'opencode');
  await fsp.writeFile(bin, `#!/usr/bin/env node
console.log('serve-started ' + process.argv.slice(2).join(' '));
process.on('SIGTERM', () => { console.log('serve-sigterm'); process.exit(0); });
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  assert.equal(fs.existsSync(bin), true);

  const agent = await startDiscoveryAgent({
    OPENCODE_BIN: bin,
    AGENT_TOKEN: 'serve-token',
    AGENT_SUPERVISE: '1',
    OPENCODE_UPSTREAM: up.url,
    OPENCODE_SERVE_PORT: '4577',
  });
  t.after(() => agent.stop());

  const health = await waitFor(async () => {
    const res = await httpJson(`${agent.base}/health`);
    return res.json?.supervisor?.running ? res : null;
  }, { what: 'supervisor running' });
  assert.equal(health.json.ok, true);
  assert.ok(health.json.supervisor.pid > 0);
  await waitFor(() => agent.output().stdout.includes('serve-started'), { what: 'serve stdout forwarded' });

  const code = await agent.stop();
  assert.equal(code, 0, 'agent exits 0 on SIGTERM');
  await waitFor(() => agent.output().stdout.includes('serve-sigterm'), { what: 'child received SIGTERM' });
});
