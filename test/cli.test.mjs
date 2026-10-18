import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempEnv, mockOpencode, startMockUpstream, verboseMeta, writeRegistry } from './helpers.mjs';
import { VERSION } from '../lib/version.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'cli.mjs');
const NODE = process.execPath;

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(NODE, [CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, PORT: '9', ...env },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr, failed: !!error });
    });
  });
}

test('cli: version', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const res = await runCli(['version'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), VERSION);
});

test('cli: models list --json reflects the registry', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free', { id: 'beta-free', status: 'verified', context: 1000 }]);
  const res = await runCli(['models', '--json'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.models.map((m) => m.id), ['alpha-free', 'beta-free']);
  assert.equal(out.models[1].status, 'verified');
  assert.equal(out.count, 2);
});

test('cli: models sync deploys new discoveries and exits 0', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free']);
  const mock = await mockOpencode(env.dir, {
    models: ['opencode/alpha-free', 'opencode/brand-new-free', 'opencode/paid-model'],
    verbose: {
      'opencode/paid-model': verboseMeta({ costInput: 5, costOutput: 20 }),
    },
  });
  const res = await runCli(['models', 'sync', '--json'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
    OPENCODE_BIN: mock.bin,
  });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'deployed');
  assert.deepEqual(out.added, ['brand-new-free']);
  const onDisk = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'models.json'), 'utf8'));
  assert.deepEqual(onDisk.models.map((m) => m.id), ['alpha-free', 'brand-new-free']);
  assert.ok(fs.readdirSync(path.join(env.dir, 'backups')).length >= 1);
});

test('cli: models sync exits 1 when discovery fails and keeps the registry', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free']);
  const mock = await mockOpencode(env.dir, { failPlain: true, exitCode: 1 });
  const res = await runCli(['models', 'sync'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
    OPENCODE_BIN: mock.bin,
  });
  assert.equal(res.code, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'models.json'), 'utf8'));
  assert.deepEqual(onDisk.models.map((m) => m.id), ['alpha-free']);
});

test('cli: models exclude removes the model and persists the exclusion', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free', 'nemotron-3-ultra-free']);
  const res = await runCli(['models', 'exclude', 'nemotron-3-ultra-free', '--reason', 'crashes'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
  });
  assert.equal(res.code, 0, res.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'models.json'), 'utf8'));
  assert.deepEqual(registry.models.map((m) => m.id), ['alpha-free']);
  const exclusions = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'exclusions.json'), 'utf8'));
  assert.deepEqual(exclusions.exclude, ['nemotron-3-ultra-free']);
  assert.equal(exclusions.reasons['nemotron-3-ultra-free'], 'crashes');
});

test('cli: models exclude supports glob patterns', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free', 'nemotron-3-ultra-free', 'nemotron-3.5-super-vl-free']);
  const res = await runCli(['models', 'exclude', 'nemotron-*'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(res.code, 0, res.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'models.json'), 'utf8'));
  assert.deepEqual(registry.models.map((m) => m.id), ['alpha-free']);
});

test('cli: models include removes the exclusion and syncs it back in', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free']);
  fs.writeFileSync(path.join(env.dir, 'config', 'exclusions.json'), JSON.stringify({
    exclude: ['special-model'], include: [], reasons: {},
  }));
  const mock = await mockOpencode(env.dir, { models: ['opencode/alpha-free', 'opencode/special-model'] });
  const res = await runCli(['models', 'include', 'special-model'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
    OPENCODE_BIN: mock.bin,
  });
  assert.equal(res.code, 0, res.stderr);
  const exclusions = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'exclusions.json'), 'utf8'));
  assert.deepEqual(exclusions.include, ['special-model']);
  const registry = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'models.json'), 'utf8'));
  assert.deepEqual(registry.models.map((m) => m.id), ['alpha-free', 'special-model']);
});

test('cli: status --json reports a down bridge without failing', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free']);
  const res = await runCli(['status', '--json'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
    OPENCODE_UPSTREAM: 'http://127.0.0.1:9',
  });
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.bridge.running, false);
  assert.equal(out.models, 1);
  assert.equal(out.upstream.connected, false);
});

test('cli: models status --json includes exclusions and verification summary', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free']);
  fs.writeFileSync(path.join(env.dir, 'config', 'exclusions.json'), JSON.stringify({
    exclude: ['nemotron-*'], include: [], reasons: { 'nemotron-*': 'crashy' },
  }));
  fs.writeFileSync(path.join(env.dir, 'state', 'verification.json'), JSON.stringify({
    'alpha-free': { status: 'verified', checkedAt: '2026-01-01T00:00:00.000Z', failCount: 0 },
  }));
  const res = await runCli(['models', 'status', '--json'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.exclusions.exclude, ['nemotron-*']);
  assert.equal(out.verification.verified, 1);
  assert.equal(out.registry.count, 1);
});

test('cli: models verify runs against a mocked upstream', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free', 'beta-free']);
  const upstream = await startMockUpstream({
    message: ({ model }) => (model === 'beta-free'
      ? { status: 500, body: { name: 'UnknownError', data: { message: 'boom', ref: 'err_x' } } }
      : { status: 200 }),
  });
  t.after(() => upstream.close());
  const res = await runCli(['models', 'verify', '--json'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
    OPENCODE_UPSTREAM: upstream.url,
    MODEL_VERIFY_MAX_PER_RUN: '10',
    MODEL_VERIFY_CONCURRENCY: '2',
  });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const alpha = out.results.find((r) => r.id === 'alpha-free');
  const beta = out.results.find((r) => r.id === 'beta-free');
  assert.equal(alpha.status, 'verified');
  assert.equal(beta.status, 'failed');
  const registry = JSON.parse(fs.readFileSync(path.join(env.dir, 'config', 'models.json'), 'utf8'));
  assert.equal(registry.models.find((m) => m.id === 'alpha-free').status, 'verified');
  assert.equal(registry.models.find((m) => m.id === 'beta-free').status, 'verification-failed');
});

test('cli: unknown command prints usage and exits 0', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const res = await runCli(['definitely-not-a-command'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /usage:/);
});
