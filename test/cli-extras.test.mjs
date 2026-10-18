// CLI surface added for Docker operations: bridge-cli wrapper, `health`,
// `config verify` and `restart` (pidfile based, Docker fallback).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempEnv, startBridgeServer, startMockUpstream, waitFor, writeRegistry } from './helpers.mjs';
import { VERSION } from '../lib/version.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'cli.mjs');
const WRAPPER = path.join(REPO, 'bridge-cli');
const NODE = process.execPath;

function runCli(args, env, script = CLI) {
  return new Promise((resolve) => {
    execFile(NODE, [script, ...args], {
      cwd: REPO,
      env: { ...process.env, PORT: '9', ...env },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr, failed: !!error });
    });
  });
}

test('bridge-cli wrapper is executable and behaves like cli.mjs', async (t) => {
  const stat = fs.statSync(WRAPPER);
  assert.ok((stat.mode & 0o111) !== 0, 'bridge-cli must be executable for the Docker symlink');

  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const res = await runCli(['version'], { OPENCODE_FREE_BRIDGE_DIR: env.dir }, WRAPPER);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), VERSION);

  const usage = await runCli(['definitely-not-a-command'], { OPENCODE_FREE_BRIDGE_DIR: env.dir }, WRAPPER);
  assert.equal(usage.code, 0);
  assert.match(usage.stdout, /usage:/);
  assert.match(usage.stdout, /opencode-free-bridge/);
});

test('cli: health --quiet maps liveness to exit codes', async (t) => {
  const { base } = await startBridgeServer(t);
  const port = new URL(base).port;
  const env = await makeTempEnv();
  t.after(() => env.cleanup());

  const up = await runCli(['health', '--quiet'], { OPENCODE_FREE_BRIDGE_DIR: env.dir, PORT: port });
  assert.equal(up.code, 0);
  assert.equal(up.stdout.trim(), '');

  const down = await runCli(['health', '--quiet'], { OPENCODE_FREE_BRIDGE_DIR: env.dir, PORT: '9' });
  assert.equal(down.code, 1);
});

test('cli: health --ready tracks readiness, not liveness', async (t) => {
  const { base } = await startBridgeServer(t, {
    env: { HEALTH_UPSTREAM_TIMEOUT_MS: '250', HEALTH_CACHE_MS: '0' },
    upstreamOptions: { health: () => 'hang' },
  });
  const port = new URL(base).port;
  const env = await makeTempEnv();
  t.after(() => env.cleanup());

  const live = await runCli(['health', '--quiet'], { OPENCODE_FREE_BRIDGE_DIR: env.dir, PORT: port });
  assert.equal(live.code, 0, 'liveness still passes during a provider outage');

  const ready = await runCli(['health', '--quiet', '--ready'], { OPENCODE_FREE_BRIDGE_DIR: env.dir, PORT: port });
  assert.equal(ready.code, 1);

  const json = await runCli(['health', '--json'], { OPENCODE_FREE_BRIDGE_DIR: env.dir, PORT: port });
  assert.equal(json.code, 0);
  const out = JSON.parse(json.stdout);
  assert.equal(out.live, true);
  assert.equal(out.ready, false);
  assert.equal(out.readiness.checks.upstream, false);
});

test('cli: config verify passes on a valid registry and fails on corruption', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free']);

  const ok = await runCli(['config', 'verify', '--json'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(ok.code, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.registry.models, 1);
  assert.equal(out.config.apiKey, 'unset');

  fs.writeFileSync(path.join(env.dir, 'config', 'models.json'), '{this is not json');
  const bad = await runCli(['config', 'verify', '--json'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(bad.code, 1);
  const badOut = JSON.parse(bad.stdout);
  assert.equal(badOut.ok, false);
  assert.match(badOut.problems.join('\n'), /models\.json/);
});

test('cli: config verify --online reports upstream reachability', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  writeRegistry(env.dir, ['alpha-free']);
  const upstream = await startMockUpstream();
  t.after(() => upstream.close());

  const ok = await runCli(['config', 'verify', '--json', '--online'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
    OPENCODE_UPSTREAM: upstream.url,
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).upstream.ok, true);

  const down = await runCli(['config', 'verify', '--json', '--online'], {
    OPENCODE_FREE_BRIDGE_DIR: env.dir,
    OPENCODE_UPSTREAM: 'http://127.0.0.1:9',
  });
  assert.equal(down.code, 0, 'unreachable upstream is a note, not a config problem');
  const downOut = JSON.parse(down.stdout);
  assert.equal(downOut.upstream.ok, false);
  assert.match(downOut.notes.join('\n'), /not reachable/);
});

test('cli: restart signals the pid from the run directory', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const child = spawn(NODE, ['-e', "process.on('SIGTERM',()=>{console.log('term');process.exit(0)});setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await waitFor(() => child.pid > 0, { what: 'child pid' });
  fs.writeFileSync(path.join(env.dir, 'run', 'bridge.pid'), `${child.pid}\n`);

  const res = await runCli(['restart'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`SIGTERM to bridge pid ${child.pid}`));
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0);
});

test('cli: restart without a pid file fails cleanly outside Docker', async (t) => {
  if (fs.existsSync('/.dockerenv')) t.skip('running inside Docker where PID 1 fallback applies');
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const res = await runCli(['restart'], { OPENCODE_FREE_BRIDGE_DIR: env.dir });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /not running/);
});
