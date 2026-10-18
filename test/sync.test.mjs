import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ModelSyncService, mergeCandidateModels } from '../lib/sync.mjs';
import { ModelRegistry } from '../lib/registry.mjs';
import { createLogger } from '../lib/logger.mjs';
import { acquireFileLock } from '../lib/fsutil.mjs';
import {
  makeTempEnv, makeModelEntry, mockOpencode, readRegistry, waitFor, writeExclusions, writeRegistry, verboseMeta,
} from './helpers.mjs';

const silent = createLogger({ silent: true });

async function setup(t, { models = ['opencode/a-free'], registryModels = ['a-free'], env = {}, spec = {} } = {}) {
  const temp = await makeTempEnv(env);
  t.after(() => temp.cleanup());
  writeRegistry(temp.dir, registryModels);
  const mock = await mockOpencode(temp.dir, { models, ...spec });
  const config = { ...temp.config, opencodeBin: mock.bin };
  const registry = new ModelRegistry({ paths: config.paths, logger: silent });
  registry.load();
  const sync = new ModelSyncService({ config, registry, logger: silent });
  return { temp, config, registry, sync, mock };
}

test('sync deploys newly discovered free models', async (t) => {
  const { temp, config, registry, sync } = await setup(t, {
    models: ['opencode/a-free', 'opencode/new-one-free'],
  });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.added, ['new-one-free']);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free', 'new-one-free']);
  assert.equal(registry.registry.lastSyncStatus, 'deployed');
  const deployments = JSON.parse(fs.readFileSync(config.paths.deploymentsFile, 'utf8')).deployments;
  assert.equal(deployments.at(-1).status, 'deployed');
  assert.equal(deployments.at(-1).added[0], 'new-one-free');
});

test('sync detects and removes retired models', async (t) => {
  const { temp, sync } = await setup(t, {
    models: ['opencode/a-free'],
    registryModels: ['a-free', 'retired-free'],
  });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.removed, ['retired-free']);
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free']);
});

test('sync skips deployment when nothing changed', async (t) => {
  const { temp, config, sync } = await setup(t, { models: ['opencode/a-free'] });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'unchanged');
  const backups = fs.readdirSync(config.paths.backupsDir);
  assert.deepEqual(backups, []);
  assert.equal(readRegistry(temp.dir).lastSyncStatus, 'unchanged');
});

test('discovery failure keeps the previous registry intact', async (t) => {
  const { temp, sync, mock } = await setup(t, { models: ['opencode/a-free'] });
  await mock.setSpec({ failPlain: true, exitCode: 1 });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'failed');
  assert.equal(result.added.length, 0);
  const onDisk = readRegistry(temp.dir);
  assert.deepEqual(onDisk.models.map((m) => m.id), ['a-free']);
  assert.equal(onDisk.lastSyncStatus, 'failed');
});

test('empty discovery output never replaces a valid registry', async (t) => {
  const { temp, sync, mock } = await setup(t, { models: ['opencode/a-free'] });
  await mock.setSpec({ models: [] });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free']);
});

test('sync refuses to deploy when every discovered model is excluded', async (t) => {
  const { temp, sync, mock } = await setup(t, { models: ['opencode/a-free'] });
  await mock.setSpec({ models: ['opencode/only-free'] });
  writeExclusions(temp.dir, { exclude: ['*'] });
  sync.registry.exclusions = sync.registry.loadExclusions();
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /refusing to deploy an empty/i);
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free']);
});

test('concurrent sync attempts do not overlap', async (t) => {
  const { sync } = await setup(t, { models: ['opencode/a-free'], spec: { delayMs: 300 } });
  const [first, second] = await Promise.all([
    sync.runOnce({ trigger: 'parallel-1' }),
    sync.runOnce({ trigger: 'parallel-2' }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, ['skipped', 'unchanged']);
  const skipped = [first, second].find((r) => r.status === 'skipped');
  assert.equal(skipped.reason, 'in-progress');
});

test('a stale cross-process lock is reclaimed, a fresh one blocks', async (t) => {
  const { config, sync } = await setup(t, { models: ['opencode/a-free'] });
  const lock = acquireFileLock(config.paths.syncLockFile, { staleMs: 60_000 });
  assert.equal(lock.acquired, true);
  const blocked = await sync.runOnce({ trigger: 'locked' });
  assert.equal(blocked.status, 'skipped');
  assert.equal(blocked.reason, 'locked');
  lock.release();
  const worked = await sync.runOnce({ trigger: 'after-release' });
  assert.equal(worked.status, 'unchanged');
});

test('MODEL_AUTO_DEPLOY=false detects changes but does not write them', async (t) => {
  const { temp, sync } = await setup(t, {
    models: ['opencode/a-free', 'opencode/pending-free'],
    env: { MODEL_AUTO_DEPLOY: 'false' },
  });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'pending');
  assert.equal(result.deployed, false);
  assert.deepEqual(result.added, ['pending-free']);
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free']);
});

test('rollback restores the registry when deployment verification fails', async (t) => {
  const { temp, registry, config, mock } = await setup(t, { models: ['opencode/a-free'] });
  await mock.setSpec({ models: ['opencode/a-free', 'opencode/new-free'] });
  const sync = new ModelSyncService({
    config,
    registry,
    logger: silent,
    verifyDeployment: async () => ({ ok: false, error: 'simulated verification failure' }),
  });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free']);
  assert.deepEqual(registry.models.map((m) => m.id), ['a-free']);
  const deployments = JSON.parse(fs.readFileSync(config.paths.deploymentsFile, 'utf8')).deployments;
  assert.equal(deployments.at(-1).status, 'rolled-back');
});

test('deployment verification is skipped when no bridge is running', async (t) => {
  const { sync } = await setup(t, {
    models: ['opencode/a-free', 'opencode/new-free'],
  });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.equal(result.deployVerificationSkipped, true);
});

test('excluded models are never deployed (special crash exclusions)', async (t) => {
  const { temp, sync, mock } = await setup(t, {
    models: ['opencode/a-free'],
    registryModels: ['a-free'],
  });
  await mock.setSpec({
    models: ['opencode/a-free', 'opencode/nemotron-3-ultra-free', 'opencode/space-bunny-free'],
    verbose: {
      'opencode/nemotron-3-ultra-free': verboseMeta({ context: 1000, output: 100 }),
    },
  });
  writeExclusions(temp.dir, { exclude: ['nemotron-*'], include: [], reasons: {} });
  sync.registry.exclusions = sync.registry.loadExclusions();
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.added, ['space-bunny-free']);
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free', 'space-bunny-free']);
  assert.equal(readRegistry(temp.dir).models.some((m) => m.id.includes('nemotron')), false);
});

test('MODEL_EXCLUDE env patterns merge with registry exclusions', async (t) => {
  const { temp, sync } = await setup(t, {
    models: ['opencode/a-free', 'opencode/blocked-free'],
    env: { MODEL_EXCLUDE: 'blocked-*' },
  });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.added, []);
  assert.deepEqual(readRegistry(temp.dir).models.map((m) => m.id), ['a-free']);
});

test('inference verification marks new models verified or failed without removing them', async (t) => {
  const { temp, sync } = await setup(t, {
    models: ['opencode/a-free'],
    env: { MODEL_VALIDATE_INFERENCE: 'true' },
  });
  const m = await mockOpencode(temp.dir, { models: ['opencode/a-free', 'opencode/good-free', 'opencode/bad-free'] });
  sync.config.opencodeBin = m.bin;
  sync.testModel = async ({ id }) => (id === 'bad-free'
    ? { ok: false, error: 'boom', errorKind: 'http' }
    : { ok: true });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.equal(result.verification.attempted, 2);
  assert.equal(result.verification.verified, 1);
  assert.equal(result.verification.failed, 1);
  const models = readRegistry(temp.dir).models;
  assert.deepEqual(models.map((m) => m.id), ['a-free', 'bad-free', 'good-free']);
  assert.equal(models.find((m) => m.id === 'good-free').status, 'verified');
  assert.equal(models.find((m) => m.id === 'bad-free').status, 'verification-failed');
  assert.ok(fs.existsSync(temp.config.paths.verificationFile));
});

test('global verification failure keeps models as discovered', async (t) => {
  const { temp, sync } = await setup(t, {
    models: ['opencode/a-free'],
    env: { MODEL_VALIDATE_INFERENCE: 'true' },
  });
  const m = await mockOpencode(temp.dir, { models: ['opencode/a-free', 'opencode/new-free'] });
  sync.config.opencodeBin = m.bin;
  sync.testModel = async () => ({ ok: false, error: 'connect ECONNREFUSED', errorKind: 'network' });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.equal(result.verification.globalFailure, true);
  const models = readRegistry(temp.dir).models;
  assert.equal(models.find((x) => x.id === 'new-free').status, 'discovered');
});

test('mergeCandidateModels preserves metadata and verification status of kept models', () => {
  const current = [makeModelEntry('keep-free', { context: 1234, status: 'verified', verifiedAt: '2026-01-01T00:00:00.000Z' })];
  const discovered = [{ id: 'keep-free', context: null, output: 55, name: 'Keep', freeReason: 'suffix' }];
  const merged = mergeCandidateModels(current, discovered);
  assert.equal(merged[0].context, 1234);
  assert.equal(merged[0].output, 55);
  assert.equal(merged[0].status, 'verified');
  assert.equal(merged[0].verifiedAt, '2026-01-01T00:00:00.000Z');
});

test('start() schedules startup sync and stop() halts the loop', async (t) => {
  const { sync } = await setup(t, {
    models: ['opencode/a-free', 'opencode/startup-free'],
    env: { MODEL_SYNC_INTERVAL_MINUTES: '60' },
  });
  sync.start();
  await waitFor(() => sync.lastResult, { timeoutMs: 5000, what: 'startup sync result' });
  assert.equal(sync.lastResult.status, 'deployed');
  assert.ok(sync.getStatus().enabled);
  sync.stop();
  assert.equal(sync.nextRunAt, null);
});

test('sync status reflects failures for the health endpoint', async (t) => {
  const { sync, mock } = await setup(t, { models: ['opencode/a-free'] });
  await mock.setSpec({ failPlain: true });
  await sync.runOnce({ trigger: 'test' });
  const status = sync.getStatus();
  assert.equal(status.lastSyncStatus, 'failed');
  assert.equal(status.lastResult.status, 'failed');
});

test('deploy verification polls until the model list matches', async (t) => {
  const { config, registry, mock } = await setup(t, { models: ['opencode/a-free'] });
  const http = await import('node:http');
  let served = ['a-free'];
  setTimeout(() => { served = ['a-free', 'fresh-free']; }, 150);
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: served.map((id) => ({ id })) }));
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  await mock.setSpec({ models: ['opencode/a-free', 'opencode/fresh-free'] });
  const sync = new ModelSyncService({
    config,
    registry,
    logger: silent,
    selfUrl: `http://127.0.0.1:${server.address().port}`,
  });
  const result = await sync.runOnce({ trigger: 'test' });
  assert.equal(result.status, 'deployed');
  assert.equal(result.deployVerified, true);
  assert.deepEqual(result.added, ['fresh-free']);
});
