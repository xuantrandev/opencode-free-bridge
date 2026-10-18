// Packaging invariants for the Docker deployment. These tests need a Docker
// daemon and are skipped by default. Run locally with:
//   RUN_DOCKER_TESTS=1 npm test
// The full end-to-end stack test additionally requires RUN_DOCKER_FULL=1 and
// builds both images (~minutes).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.RUN_DOCKER_TESTS === '1';
const skip = enabled ? false : 'set RUN_DOCKER_TESTS=1 to run Docker tests';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: REPO, timeout: 900_000, ...opts }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('docker: compose file validates and interpolates', { skip }, async () => {
  const res = await run('docker', ['compose', 'config', '-q']);
  assert.equal(res.code, 0, res.stderr);
});

test('docker: required build/packaging files exist and scripts are executable', { skip }, () => {
  for (const file of ['Dockerfile.bridge', 'Dockerfile.opencode', 'docker-compose.yml', '.dockerignore', '.env.example']) {
    assert.ok(fs.existsSync(path.join(REPO, file)), `${file} missing`);
  }
  for (const file of ['docker/bridge-entrypoint.sh', 'docker/opencode-entrypoint.sh', 'scripts/migrate-auth.sh']) {
    const mode = fs.statSync(path.join(REPO, file)).mode;
    assert.ok((mode & 0o111) !== 0, `${file} must be executable`);
  }
});

test('docker: full stack boots, becomes healthy and serves /v1/models', {
  skip: enabled && process.env.RUN_DOCKER_FULL === '1' ? false : 'set RUN_DOCKER_FULL=1 for the full stack test',
  timeout: 900_000,
}, async (t) => {
  t.after(async () => { await run('docker', ['compose', 'down', '-v', '--remove-orphans']); });
  const up = await run('docker', ['compose', 'up', '-d', '--build'], { timeout: 900_000 });
  assert.equal(up.code, 0, `${up.stdout}\n${up.stderr}`);
  await new Promise((r) => setTimeout(r, 3000));
  const ps = await run('docker', ['compose', 'ps', '--format', 'json']);
  assert.ok(ps.stdout.includes('opencode-server'));

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    const inspect = await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', 'opencode-free-bridge-opencode-server-1']);
    const bridge = await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', 'opencode-free-bridge-opencode-bridge-1']);
    healthy = inspect.stdout.trim() === 'healthy' && bridge.stdout.trim() === 'healthy';
    if (!healthy) await new Promise((r) => setTimeout(r, 2000));
  }
  assert.ok(healthy, 'both containers must report healthy');
});
