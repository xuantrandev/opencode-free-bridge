import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ModelRegistry, diffIds, normalizeRegistry, validateCandidateModels } from '../lib/registry.mjs';
import { makeTempEnv, writeRegistry, writeExclusions, makeModelEntry, readRegistry } from './helpers.mjs';
import { atomicWriteJson, acquireFileLock } from '../lib/fsutil.mjs';

test('normalizeRegistry accepts the legacy string-array format', () => {
  const { valid, registry } = normalizeRegistry({ models: ['a-free', 'b-free'], lastUpdated: null });
  assert.equal(valid, true);
  assert.deepEqual(registry.models.map((m) => m.id), ['a-free', 'b-free']);
  assert.equal(registry.models[0].status, 'discovered');
});

test('normalizeRegistry rejects malformed registries', () => {
  assert.equal(normalizeRegistry(null).valid, false);
  assert.equal(normalizeRegistry({ models: 'nope' }).valid, false);
  assert.equal(normalizeRegistry([1, 2, 3]).valid, false);
});

test('normalizeRegistry drops invalid entries and duplicates', () => {
  const { valid, errors, registry } = normalizeRegistry({
    models: ['ok-free', '', 'bad id', { id: 'obj-free' }, 'ok-free'],
  });
  assert.equal(valid, true);
  assert.deepEqual(registry.models.map((m) => m.id), ['obj-free', 'ok-free']);
  assert.equal(errors.length, 3);
});

test('diffIds detects added/removed/kept', () => {
  const d = diffIds(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepEqual(d.added, ['d']);
  assert.deepEqual(d.removed, ['a']);
  assert.deepEqual(d.kept, ['b', 'c']);
});

test('validateCandidateModels refuses empty lists over non-empty registries', () => {
  const res = validateCandidateModels([], { previous: ['a'] });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /refusing to deploy an empty/);
  assert.equal(validateCandidateModels([], { previous: [] }).ok, true);
  assert.equal(validateCandidateModels(['fine-free'], { previous: [] }).ok, true);
  assert.equal(validateCandidateModels(['bad id!'], { previous: [] }).ok, false);
});

test('registry.load falls back to models.json.bak when primary is corrupt', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['good-free']);
  fs.copyFileSync(path.join(env.dir, 'config', 'models.json'), path.join(env.dir, 'config', 'models.json.bak'));
  await fsp.writeFile(path.join(env.dir, 'config', 'models.json'), '{ this is not json');

  const registry = new ModelRegistry({ paths: env.config.paths });
  const result = registry.load();
  assert.equal(result.registry.models.length, 1);
  assert.equal(registry.models[0].id, 'good-free');
  assert.match(result.source, /models\.json\.bak$/);
});

test('registry.load falls back to models.default.json when everything else is broken', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['from-default-free']);
  await fsp.copyFile(path.join(env.dir, 'config', 'models.json'), env.config.paths.modelsDefaultFile);
  await fsp.writeFile(path.join(env.dir, 'config', 'models.json'), 'garbage');
  await fsp.writeFile(path.join(env.dir, 'config', 'models.json.bak'), 'garbage too');

  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  assert.deepEqual(registry.models.map((m) => m.id), ['from-default-free']);
});

test('registry.load with no files at all starts empty and does not throw', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  assert.equal(registry.models.length, 0);
  assert.ok(registry.reloadFromDisk().registry);
});

test('deploy writes atomically, creates a backup, and updates the snapshot', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['old-free']);
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  const previous = registry.snapshot();

  const { backup, diff } = await registry.deploy([makeModelEntry('new-free'), makeModelEntry('old-free')], { reason: 'test' });
  assert.ok(backup && fs.existsSync(backup));
  assert.deepEqual(diff.added, ['new-free']);
  assert.deepEqual(readRegistry(env.dir).models.map((m) => m.id), ['new-free', 'old-free']);
  assert.ok(fs.existsSync(path.join(env.dir, 'config', 'models.json.bak')));
  assert.equal(registry.registry.generation, previous.generation + 1);

  const leftovers = fs.readdirSync(path.join(env.dir, 'config')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('concurrent deploys serialize through the write queue', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['base-free']);
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  await Promise.all([
    registry.deploy([makeModelEntry('a-free'), makeModelEntry('base-free')], { reason: 'c1' }),
    registry.deploy([makeModelEntry('b-free'), makeModelEntry('base-free')], { reason: 'c2' }),
    registry.deploy([makeModelEntry('c-free'), makeModelEntry('base-free')], { reason: 'c3' }),
  ]);
  const onDisk = readRegistry(env.dir).models.map((m) => m.id).sort();
  assert.deepEqual(onDisk, ['base-free', 'c-free']);
  assert.equal(registry.registry.generation, 4);
});

test('rollback restores the previous snapshot', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['stable-free']);
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  registry.capturePrevious();
  await registry.deploy([makeModelEntry('broken-free')], { reason: 'test' });
  assert.deepEqual(registry.models.map((m) => m.id), ['broken-free']);
  await registry.rollback('test-rollback');
  assert.deepEqual(registry.models.map((m) => m.id), ['stable-free']);
  assert.deepEqual(readRegistry(env.dir).models.map((m) => m.id), ['stable-free']);
});

test('hot reload picks up external file changes (mtime polling)', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['one-free']);
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  const events = [];
  registry.on('change', (e) => events.push(e));

  await new Promise((r) => setTimeout(r, 10));
  writeRegistry(env.dir, ['one-free', 'two-free']);
  const result = registry.reloadFromDisk({ force: true });
  assert.equal(result.changed, true);
  assert.deepEqual(registry.models.map((m) => m.id), ['one-free', 'two-free']);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].added, ['two-free']);
});

test('reload keeps in-memory registry when the file becomes unreadable', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['keep-free']);
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  await fsp.rm(path.join(env.dir, 'config', 'models.json'));
  const result = registry.reloadFromDisk({ force: true });
  assert.equal(registry.models.length, 1);
  assert.equal(registry.models[0].id, 'keep-free');
  assert.ok(result.errors.length >= 0); // tolerated either way
});

test('exclusion helpers persist and update in-memory state', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['a-free']);
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  await registry.setExclusion('nemotron-*', 'known to crash');
  await registry.setExclusion('exact-free');
  assert.deepEqual(registry.exclusions.exclude, ['exact-free', 'nemotron-*']);
  assert.equal(registry.exclusions.reasons['nemotron-*'], 'known to crash');
  await registry.removeExclusion('exact-free');
  assert.deepEqual(registry.exclusions.exclude, ['nemotron-*']);
  await registry.setInclude('mystery-model');
  assert.deepEqual(registry.exclusions.include, ['mystery-model']);
  const onDisk = JSON.parse(fs.readFileSync(env.config.paths.exclusionsFile, 'utf8'));
  assert.deepEqual(onDisk.exclude, ['nemotron-*']);
  assert.deepEqual(onDisk.include, ['mystery-model']);
});

test('atomicWriteJson never leaves partial files behind', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const file = path.join(env.dir, 'state', 'x.json');
  await Promise.all(Array.from({ length: 10 }, (_, i) => atomicWriteJson(file, { i })));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof parsed.i, 'number');
  const leftovers = fs.readdirSync(path.join(env.dir, 'state')).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('acquireFileLock prevents overlap and reclaims stale locks', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const lockFile = path.join(env.dir, 'state', 'sync.lock');
  const first = acquireFileLock(lockFile, { staleMs: 10_000 });
  assert.equal(first.acquired, true);
  const second = acquireFileLock(lockFile, { staleMs: 10_000 });
  assert.equal(second.acquired, false);
  first.release();
  const third = acquireFileLock(lockFile, { staleMs: 10_000 });
  assert.equal(third.acquired, true);
  third.release();

  fs.writeFileSync(lockFile, '{}');
  const old = Date.now() - 60_000;
  fs.utimesSync(lockFile, old / 1000, old / 1000);
  const reclaimed = acquireFileLock(lockFile, { staleMs: 1000 });
  assert.equal(reclaimed.acquired, true);
  reclaimed.release();
});

test('writeExclusions + registry.load picks up patterns', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['a-free']);
  writeExclusions(env.dir, { exclude: ['x-*'], include: ['y-model'], reasons: { 'x-*': 'nope' } });
  const registry = new ModelRegistry({ paths: env.config.paths });
  registry.load();
  assert.deepEqual(registry.excludePatterns, ['x-*']);
  assert.deepEqual(registry.exclusions.include, ['y-model']);
});
