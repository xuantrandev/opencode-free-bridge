// Liveness (/health) vs readiness (/health/ready): a temporary provider
// outage must degrade readiness without failing liveness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { httpJson, startBridgeServer } from './helpers.mjs';

test('GET /health/ready is ready when the registry and upstream are healthy', async (t) => {
  const { base } = await startBridgeServer(t);
  const res = await httpJson(`${base}/health/ready`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ready, true);
  assert.deepEqual(res.json.checks, { bridge: true, registry: true, upstream: true });
  assert.equal(res.json.modelCount, 2);
  assert.equal(typeof res.json.registryHash, 'string');
});

test('provider outage degrades /health (200) and fails /health/ready (503)', async (t) => {
  const { base } = await startBridgeServer(t, {
    env: { HEALTH_UPSTREAM_TIMEOUT_MS: '250', HEALTH_CACHE_MS: '0' },
    upstreamOptions: { health: () => 'hang' },
  });
  const health = await httpJson(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'degraded');
  assert.equal(health.json.ok, true);
  assert.equal(health.json.upstream, 'disconnected');
  assert.equal(health.json.bridge.ok, true);

  const ready = await httpJson(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  assert.equal(ready.json.ready, false);
  assert.equal(ready.json.checks.upstream, false);
  assert.equal(ready.json.checks.bridge, true);
});

test('an empty registry is not ready', async (t) => {
  const { base } = await startBridgeServer(t, { models: [] });
  const ready = await httpJson(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  assert.equal(ready.json.ready, false);
  assert.equal(ready.json.checks.registry, false);
  assert.equal(ready.json.checks.upstream, true);
});

test('/health reports registry, sync and discovery status without inference', async (t) => {
  const { base, up } = await startBridgeServer(t);
  const res = await httpJson(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.json.registry.ok, true);
  assert.equal(res.json.registry.models, 2);
  assert.equal(res.json.registry.generation, 1);
  assert.equal(res.json.discovery.mode, 'cli');
  assert.equal(res.json.modelSync, 'enabled');
  assert.equal(typeof res.json.bridge.uptimeSeconds, 'number');
  assert.equal(typeof res.json.registryHash, 'string');
  assert.equal(res.json.lastSyncResult, null);
  // No inference calls were made by any health probe.
  assert.equal(up.state.calls.some((c) => c.url.endsWith('/message')), false);
});
