import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../deploy.sh', import.meta.url));
const bash = execFileSync('bash', ['-c', 'printf "%s" "$BASH"'], { encoding: 'utf8' });
const dirname = execFileSync('sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).trim();
const envContents = 'DISCOVERY_TOKEN=test-token\nBRIDGE_BIND=127.0.0.1\n';

async function fixture(t, { configured = true, docker = true, failure = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ofb-deploy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'checkout with spaces');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'docker.log');
  await fs.mkdir(repo);
  await fs.mkdir(bin);
  await fs.copyFile(script, path.join(repo, 'deploy.sh'));
  await fs.symlink(dirname, path.join(bin, 'dirname'));
  if (configured) await fs.writeFile(path.join(repo, '.env'), envContents);
  if (docker) {
    await fs.writeFile(path.join(bin, 'docker'), `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$*" >> "$DEPLOY_TEST_LOG"
if [ "$*" = "$DEPLOY_TEST_FAILURE" ]; then
  printf 'mock docker failure\\n' >&2
  exit 17
fi
`, { mode: 0o755 });
  }
  return {
    repo,
    async invoke(args = []) {
      try {
        const result = await run(bash, [path.join(repo, 'deploy.sh'), ...args], {
          cwd: root,
          env: { ...process.env, PATH: bin, DEPLOY_TEST_LOG: log, DEPLOY_TEST_FAILURE: failure },
          timeout: 10_000,
        });
        return { ...result, code: 0 };
      } catch (error) {
        return { stdout: error.stdout, stderr: error.stderr, code: error.code };
      }
    },
    async calls() {
      const content = await fs.readFile(log, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return content.trim().split('\n').filter(Boolean);
    },
  };
}

test('deploy: script is executable', async () => {
  assert.ok((await fs.stat(script)).mode & 0o111);
});

for (const flag of ['-h', '--help']) {
  test(`deploy: ${flag} works without configuration or Docker`, async (t) => {
    const env = await fixture(t, { configured: false, docker: false });
    const result = await env.invoke([flag]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--stop/);
    assert.deepEqual(await env.calls(), []);
  });
}

test('deploy: rejects unknown arguments', async (t) => {
  const env = await fixture(t);
  const result = await env.invoke(['--systemd']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option: --systemd/);
  assert.deepEqual(await env.calls(), []);
});

test('deploy: missing .env gives setup instructions without creating it', async (t) => {
  const env = await fixture(t, { configured: false });
  const result = await env.invoke();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Copy .env.example to .env/);
  await assert.rejects(fs.access(path.join(env.repo, '.env')), { code: 'ENOENT' });
  assert.deepEqual(await env.calls(), []);
});

test('deploy: missing Docker gives installation instructions', async (t) => {
  const env = await fixture(t, { docker: false });
  const result = await env.invoke();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Install Docker/);
  assert.deepEqual(await env.calls(), []);
});

const commands = ['compose version', 'info', 'compose config --quiet', 'compose up -d --build', 'compose ps'];
for (const [index, failure] of commands.entries()) {
  test(`deploy: stops when ${failure} fails`, async (t) => {
    const env = await fixture(t, { failure });
    const result = await env.invoke();
    assert.equal(result.code, index < 2 ? 1 : 17);
    assert.deepEqual(await env.calls(), commands.slice(0, index + 1).map((command) => `${env.repo}|${command}`));
    if (index === 0) assert.match(result.stderr, /Install the Docker Compose plugin/);
    if (index === 1) assert.match(result.stderr, /Start Docker and check your Docker permissions/);
    assert.doesNotMatch(result.stdout, /Services started/);
  });
}

test('deploy: runs from its own directory and preserves existing configuration', async (t) => {
  const env = await fixture(t);
  const result = await env.invoke();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await env.calls(), commands.map((command) => `${env.repo}|${command}`));
  assert.equal(await fs.readFile(path.join(env.repo, '.env'), 'utf8'), envContents);
  assert.match(result.stdout, /Services started/);
});

const stopCommands = ['compose version', 'info', 'compose down'];
for (const configured of [true, false]) {
  test(`deploy: --stop preserves volumes ${configured ? 'with' : 'without'} .env`, async (t) => {
    const env = await fixture(t, { configured });
    const result = await env.invoke(['--stop']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await env.calls(), stopCommands.map((command) => `${env.repo}|${command}`));
    assert.match(result.stdout, /Services stopped. Named volumes preserved/);
    if (configured) {
      assert.equal(await fs.readFile(path.join(env.repo, '.env'), 'utf8'), envContents);
    } else {
      await assert.rejects(fs.access(path.join(env.repo, '.env')), { code: 'ENOENT' });
    }
  });
}

for (const [index, failure] of stopCommands.entries()) {
  test(`deploy: --stop fails when ${failure} fails`, async (t) => {
    const env = await fixture(t, { failure });
    const result = await env.invoke(['--stop']);
    assert.equal(result.code, index < 2 ? 1 : 17);
    assert.deepEqual(await env.calls(), stopCommands.slice(0, index + 1).map((command) => `${env.repo}|${command}`));
    assert.doesNotMatch(result.stdout, /Services stopped/);
  });
}
