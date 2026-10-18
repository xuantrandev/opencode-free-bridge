import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyModel, discoverModels, parseModelListOutput, parseVerboseOutput, DiscoveryError,
} from '../lib/discovery.mjs';
import { makeTempEnv, mockOpencode, verboseMeta } from './helpers.mjs';

test('parseModelListOutput extracts opencode/<id> and counts malformed lines', () => {
  const { ids, malformed } = parseModelListOutput([
    'opencode/beam-free',
    'opencode/big-pickle',
    '',
    'WARNING: cache is stale',
    'opencode/space bunny',
    'opencode/space-bunny-free',
    'opencode/beam-free', // duplicate
  ].join('\n'));
  assert.deepEqual(ids, ['opencode/beam-free', 'opencode/big-pickle', 'opencode/space-bunny-free']);
  assert.equal(malformed, 2);
});

test('parseVerboseOutput parses metadata blocks after id lines', () => {
  const text = [
    'opencode/beam-free',
    JSON.stringify(verboseMeta({ context: 1048576, output: 131072, name: 'Beam Free' }), null, 2),
    'opencode/big-pickle',
    JSON.stringify(verboseMeta({ context: 200000, output: 32000, name: 'Big Pickle' }), null, 2),
  ].join('\n');
  const parsed = parseVerboseOutput(text);
  assert.equal(parsed.get('opencode/beam-free').limit.context, 1048576);
  assert.equal(parsed.get('opencode/big-pickle').limit.output, 32000);
});

test('classifyModel accepts -free suffix, known free ids, zero-cost models, and include list', () => {
  assert.equal(classifyModel('opencode/beam-free').freeReason, 'suffix');
  assert.equal(classifyModel('opencode/big-pickle').freeReason, 'known-free');
  assert.equal(classifyModel('opencode/other-model', { include: ['other-*'] }).freeReason, 'admin-include');
  assert.equal(classifyModel('opencode/other-model'), null);
  const zeroCost = classifyModel('opencode/mystery-model', {
    verbose: new Map([['opencode/mystery-model', { cost: { input: 0, output: 0 } }]]),
  });
  assert.equal(zeroCost.freeReason, 'zero-cost');
});

test('classifyModel rejects unknown models without free evidence', () => {
  assert.equal(classifyModel('opencode/some-paid-model'), null);
});

test('classifyModel rejects paid models even when suffixed -free', () => {
  const paid = classifyModel('opencode/tricky-free', {
    verbose: new Map([['opencode/tricky-free', { cost: { input: 3, output: 15 } }]]),
  });
  assert.equal(paid, null);
});

test('classifyModel rejects paid models listed without metadata as non-free', () => {
  assert.equal(classifyModel('opencode/claude-sonnet-9'), null);
});

test('discovery end-to-end with mocked opencode CLI (new free models)', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const mock = await mockOpencode(env.dir, {
    models: ['opencode/beam-free', 'opencode/big-pickle', 'opencode/new-model-free', 'opencode/claude-paid'],
    verbose: {
      'opencode/beam-free': verboseMeta({ context: 1000, output: 100, name: 'Beam' }),
      'opencode/big-pickle': verboseMeta({ context: 2000, output: 200, name: 'Pickle' }),
      'opencode/new-model-free': verboseMeta({ context: 3000, output: 300, name: 'New' }),
      'opencode/claude-paid': verboseMeta({ context: 9000, output: 900, costInput: 3, costOutput: 15 }),
    },
  });
  const result = await discoverModels({ bin: mock.bin, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((m) => m.id), ['beam-free', 'big-pickle', 'new-model-free']);
  assert.deepEqual(result.rejected, ['claude-paid']);
  assert.equal(result.models[0].context, 1000);
  assert.equal(result.verboseUsed, true);
});

test('discovery without verbose metadata still finds suffixed + known free models', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const mock = await mockOpencode(env.dir, {
    models: ['opencode/x-free', 'opencode/big-pickle', 'opencode/paid-pro'],
    failVerbose: true,
  });
  const result = await discoverModels({ bin: mock.bin, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((m) => m.id), ['big-pickle', 'x-free']);
  assert.equal(result.verboseUsed, false);
});

test('discovery applies exclusions (pattern + exact)', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const mock = await mockOpencode(env.dir, {
    models: ['opencode/a-free', 'opencode/nemotron-3-ultra-free', 'opencode/keep-me-free'],
  });
  const result = await discoverModels({ bin: mock.bin, exclude: ['nemotron-*', 'keep-me-free'], timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((m) => m.id), ['a-free']);
  assert.deepEqual(result.excluded.map((e) => e.id).sort(), ['keep-me-free', 'nemotron-3-ultra-free']);
});

test('discovery refuses empty CLI output', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const mock = await mockOpencode(env.dir, { models: [] });
  const result = await discoverModels({ bin: mock.bin, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'empty');
});

test('discovery rejects malformed CLI output', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const mock = await mockOpencode(env.dir, { rawText: 'not a model list\nrandom garbage\n' });
  const result = await discoverModels({ bin: mock.bin, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'empty');
  assert.equal(result.malformed, 2);
});

test('discovery reports CLI failure and timeout', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const failing = await mockOpencode(env.dir, { failPlain: true, exitCode: 2 });
  const failed = await discoverModels({ bin: failing.bin, timeoutMs: 5000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, 'exit');

  await failing.setSpec({ models: ['opencode/a-free'], delayMs: 1000 });
  const timedOut = await discoverModels({ bin: failing.bin, timeoutMs: 150 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.kind, 'timeout');
});

test('discovery reports missing binary', async (t) => {
  const env = await makeTempEnv();
  t.after(() => env.cleanup());
  const result = await discoverModels({ bin: '/nonexistent/opencode-mock', timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'spawn');
});

test('DiscoveryError type is exported for callers', () => {
  const err = new DiscoveryError('boom', 'timeout');
  assert.equal(err.name, 'DiscoveryError');
  assert.equal(err.kind, 'timeout');
});
