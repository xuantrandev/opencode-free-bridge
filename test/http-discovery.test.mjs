// Discovery through the internal agent (container topology): the bridge must
// never try to execute the opencode CLI in its own container. These tests run
// the real agent with a mocked CLI and drive lib/agent-discovery.mjs +
// lib/sync.mjs against it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunner } from '../lib/agent-discovery.mjs';
import { discoverModels } from '../lib/discovery.mjs';
import { ModelSyncService, httpVerifyDeployment } from '../lib/sync.mjs';
import { ModelRegistry } from '../lib/registry.mjs';
import { createLogger } from '../lib/logger.mjs';
import { OpenCodeClient } from '../lib/opencode-client.mjs';
import {
  httpJson, makeTempEnv, mockOpencode, readRegistry, startDiscoveryAgent, verboseMeta, writeRegistry,
} from './helpers.mjs';

const silent = createLogger({ silent: true });

async function setup(t, spec = {}) {
  const temp = await makeTempEnv();
  t.after(() => temp.cleanup());
  const mock = await mockOpencode(temp.dir, spec);
  const agent = await startDiscoveryAgent({ OPENCODE_BIN: mock.bin, AGENT_TOKEN: 'agent-token', AGENT_SUPERVISE: '0' });
  t.after(() => agent.stop());
  return { temp, mock, agent };
}

test('createAgentRunner rejects unsupported commands without network calls', async () => {
  const runner = createAgentRunner({ url: 'http://127.0.0.1:9' });
  const res = await runner({ args: ['serve'], timeoutMs: 100 });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'unsupported');
});

test('discovery through the agent classifies free models and rejects paid ones', async (t) => {
  const { agent } = await setup(t, {
    models: ['opencode/a-free', 'opencode/big-pickle', 'opencode/paid-pro'],
    verbose: {
      'opencode/a-free': verboseMeta({ context: 1111, output: 222, name: 'A' }),
      'opencode/paid-pro': verboseMeta({ context: 9000, output: 900, costInput: 5, costOutput: 15 }),
    },
  });
  const runner = createAgentRunner({ url: agent.base, token: 'agent-token', timeoutMs: 5000 });
  const result = await discoverModels({ runner, provider: 'opencode', timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((m) => m.id), ['a-free', 'big-pickle']);
  assert.deepEqual(result.rejected, ['paid-pro']);
  assert.equal(result.models[0].context, 1111);
  assert.equal(result.verboseUsed, true);
});

test('discovery through the agent honors exclusions', async (t) => {
  const { agent } = await setup(t, {
    models: ['opencode/a-free', 'opencode/nemotron-3-ultra-free'],
  });
  const runner = createAgentRunner({ url: agent.base, token: 'agent-token', timeoutMs: 5000 });
  const result = await discoverModels({ runner, exclude: ['nemotron-*'], timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((m) => m.id), ['a-free']);
  assert.deepEqual(result.excluded.map((e) => e.id), ['nemotron-3-ultra-free']);
});

test('discovery fails conservatively when the agent is unreachable', async () => {
  const runner = createAgentRunner({ url: 'http://127.0.0.1:9', token: 'x', timeoutMs: 300, fetchRetries: 0 });
  const result = await discoverModels({ runner, timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'network');
  assert.deepEqual(result.models, []);
});

test('discovery reports authentication failures distinctly', async (t) => {
  const { agent } = await setup(t, { models: ['opencode/a-free'] });
  const runner = createAgentRunner({ url: agent.base, token: 'wrong-token', timeoutMs: 5000 });
  const result = await discoverModels({ runner, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'auth');
});

test('agent replies are surfaced as empty-discovery failures', async (t) => {
  const { agent } = await setup(t, { models: [] });
  const runner = createAgentRunner({ url: agent.base, token: 'agent-token', timeoutMs: 5000 });
  const result = await discoverModels({ runner, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'empty');
});

test('ModelSyncService uses the agent runner when DISCOVERY_URL is configured', async (t) => {
  const { temp, agent } = await setup(t, {
    models: ['opencode/a-free', 'opencode/new-free'],
    verbose: {
      'opencode/a-free': verboseMeta({ context: 100, output: 10 }),
      'opencode/new-free': verboseMeta({ context: 200, output: 20 }),
    },
  });
  writeRegistry(temp.dir, ['a-free']);
  const config = { ...temp.config, discoveryUrl: agent.base, discoveryToken: 'agent-token' };
  const registry = new ModelRegistry({ paths: config.paths, logger: silent });
  registry.load();
  const sync = new ModelSyncService({ config, registry, logger: silent });
  assert.equal(sync.discoveryMode, 'agent');

  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.added, ['new-free']);
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free', 'new-free']);
});

test('sync keeps the registry when the agent dies mid-flight', async (t) => {
  const { temp, agent } = await setup(t, { models: ['opencode/a-free', 'opencode/new-free'] });
  writeRegistry(temp.dir, ['a-free']);
  const config = { ...temp.config, discoveryUrl: agent.base, discoveryToken: 'agent-token' };
  const registry = new ModelRegistry({ paths: config.paths, logger: silent });
  registry.load();
  await agent.stop();
  const sync = new ModelSyncService({ config, registry, logger: silent });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.kind, 'network');
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free']);
});

test('httpVerifyDeployment authenticates with the bridge API key', async (t) => {
  const http = await import('node:http');
  const requireKey = (req) => req.headers.authorization === 'Bearer secret-key';
  const server = http.createServer((req, res) => {
    if (!requireKey(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'no key' } }));
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'a-free' }] }));
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const missingKey = await httpVerifyDeployment({ baseUrl, expectedIds: ['a-free'], timeoutMs: 500, fetchImpl: fetch });
  assert.equal(missingKey.ok, false);

  const withKey = await httpVerifyDeployment({ baseUrl, expectedIds: ['a-free'], timeoutMs: 1000, fetchImpl: fetch, apiKey: 'secret-key' });
  assert.equal(withKey.ok, true);
  assert.equal(withKey.verified, true);

  const client = new OpenCodeClient({ upstream: baseUrl, logger: silent });
  assert.equal(typeof client, 'object');
});
