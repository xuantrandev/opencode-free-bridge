import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer, partsFromOpenAIMessages } from '../server.mjs';
import { ModelRegistry } from '../lib/registry.mjs';
import { OpenCodeClient } from '../lib/opencode-client.mjs';
import { createLogger } from '../lib/logger.mjs';
import {
  makeTempEnv, httpJson, readSse, startMockUpstream, waitFor, writeRegistry, makeModelEntry,
} from './helpers.mjs';

const silent = createLogger({ silent: true });

async function startBridge(t, {
  models = ['a-free', 'b-free'],
  upstreamOptions = {},
  env = {},
  upstream = null,
} = {}) {
  const up = upstream ?? await startMockUpstream(upstreamOptions);
  if (!upstream) t.after(() => up.close());
  const temp = await makeTempEnv({
    UPSTREAM_RETRY_BASE_MS: '10',
    HEALTH_CACHE_MS: '0',
    ...env,
  });
  t.after(() => temp.cleanup());
  writeRegistry(temp.dir, models);
  const config = { ...temp.config, port: 0, upstream: up.url, logFile: '' };
  const registry = new ModelRegistry({ paths: config.paths, logger: silent });
  registry.load();
  const client = new OpenCodeClient({
    upstream: up.url,
    provider: config.provider,
    agent: config.agent,
    timeoutMs: config.upstreamTimeoutMs,
    connectTimeoutMs: config.upstreamConnectTimeoutMs,
    retries: config.upstreamRetries,
    retryBaseMs: config.upstreamRetryBaseMs,
    logger: silent,
  });
  const bridge = createBridgeServer({ config, registry, logger: silent, client });
  await bridge.listen(0, '127.0.0.1');
  t.after(() => bridge.close());
  return { bridge, config, registry, temp, up, base: `http://127.0.0.1:${bridge.port}` };
}

test('partsFromOpenAIMessages includes history by default and can drop it', () => {
  const messages = [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] },
  ];
  const withHistory = partsFromOpenAIMessages(messages);
  const text = withHistory.parts[0].text;
  assert.match(text, /\[system\]\nbe nice/);
  assert.match(text, /\[user\]\nfirst question/);
  assert.match(text, /\[assistant\]\nfirst answer/);
  assert.match(text, /second question$/);

  const noHistory = partsFromOpenAIMessages(messages, { includeHistory: false, systemDefault: 'x' });
  assert.equal(noHistory.parts[0].text.includes('first question'), false);
  assert.match(noHistory.parts[0].text, /second question/);
});

test('GET /v1/models serves the registry', async (t) => {
  const { base, registry } = await startBridge(t);
  const res = await httpJson(`${base}/v1/models`);
  assert.equal(res.status, 200);
  assert.equal(res.json.object, 'list');
  assert.deepEqual(res.json.data.map((m) => m.id), ['auto', 'a-free', 'b-free']);
  const auto = res.json.data[0];
  assert.equal(auto.id, 'auto');
  assert.equal(auto.free, true);
  assert.equal(auto.status, 'auto');
  assert.deepEqual(auto.priority, ['deepseek', 'glm']);
  const ids = res.json.data.slice(1).map((m) => m.id);
  assert.deepEqual(ids, ['a-free', 'b-free']);
  assert.equal(res.json.data[1].object, 'model');
  assert.equal(res.json.data[1].free, true);
  assert.equal(registry.models.length, 2);

  const one = await httpJson(`${base}/v1/models/a-free`);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, 'a-free');
  const autoOne = await httpJson(`${base}/v1/models/auto`);
  assert.equal(autoOne.status, 200);
  assert.equal(autoOne.json.id, 'auto');
  const autoUpper = await httpJson(`${base}/v1/models/AUTO`);
  assert.equal(autoUpper.status, 200);
  assert.equal(autoUpper.json.id, 'auto');
  const missing = await httpJson(`${base}/v1/models/nope-free`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'model_not_found');
});

test('POST /v1/chat/completions returns an OpenAI-shaped response', async (t) => {
  const { base, up } = await startBridge(t);
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.model, 'a-free');
  assert.equal(res.json.choices[0].message.role, 'assistant');
  assert.equal(res.json.choices[0].message.content, 'echo:a-free');
  assert.equal(res.json.choices[0].finish_reason, 'stop');
  assert.deepEqual(res.json.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  const messageCall = up.state.calls.find((c) => c.url.endsWith('/message'));
  assert.equal(messageCall.body.model.modelID, 'a-free');
  assert.equal(messageCall.body.model.providerID, 'opencode');
});

test('unknown model is rejected locally with an OpenAI 404 error', async (t) => {
  const { base, up } = await startBridge(t);
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'does-not-exist', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'invalid_request_error');
  assert.equal(res.json.error.code, 'model_not_found');
  assert.match(res.json.error.message, /a-free, b-free/);
  assert.equal(up.state.calls.some((c) => c.url.endsWith('/message')), false, 'no upstream inference for unknown models');
});

test('AUTO resolves to deepseek over glm and other models', async (t) => {
  const { base, up } = await startBridge(t, {
    models: ['other-free', 'glm-5.3-flash-free', 'deepseek-v4.1-flash-free'],
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.model, 'deepseek-v4.1-flash-free');
  assert.equal(up.state.messageCounts['deepseek-v4.1-flash-free'], 1);
  assert.equal(up.state.messageCounts['glm-5.3-flash-free'] ?? 0, 0);
  const upper = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'AUTO', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(upper.status, 200);
  assert.equal(upper.json.model, 'deepseek-v4.1-flash-free');
});

test('AUTO falls back to glm when deepseek is absent, and to any model otherwise', async (t) => {
  const { base, up } = await startBridge(t, {
    models: ['other-free', 'glm-5.3-flash-free'],
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.model, 'glm-5.3-flash-free');
  assert.equal(up.state.messageCounts['glm-5.3-flash-free'], 1);

  const { base: base2, up: up2 } = await startBridge(t, { models: ['zeta-free', 'alpha-free'] });
  const res2 = await httpJson(`${base2}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.json.model, 'alpha-free');
  assert.equal(up2.state.messageCounts['alpha-free'], 1);
});

test('AUTO: family priority wins over verified status, verified wins within a family', async (t) => {
  const { base } = await startBridge(t, {
    models: [
      makeModelEntry('deepseek-v4.1-flash-free'),
      makeModelEntry('glm-5.3-flash-free', { status: 'verified', verifiedAt: '2026-01-01T00:00:00.000Z' }),
    ],
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.model, 'deepseek-v4.1-flash-free');

  const { base: base2 } = await startBridge(t, {
    models: [
      makeModelEntry('deepseek-a-free'),
      makeModelEntry('deepseek-b-free', { status: 'verified', verifiedAt: '2026-01-01T00:00:00.000Z' }),
    ],
  });
  const res2 = await httpJson(`${base2}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.json.model, 'deepseek-b-free');
});

test('AUTO with an empty registry returns 404 model_not_found', async (t) => {
  const { base, up } = await startBridge(t, { models: [] });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'AUTO', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'model_not_found');
  assert.match(res.json.error.message, /'auto'/);
  assert.equal(up.state.calls.some((c) => c.url.endsWith('/message')), false);
});

test('invalid JSON and missing model produce 400s', async (t) => {
  const { base } = await startBridge(t);
  const bad = await httpJson(`${base}/v1/chat/completions`, { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'invalid_json');
  const noModel = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(noModel.status, 400);
  assert.equal(noModel.json.error.code, 'missing_model');
  const noMessages = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [] },
  });
  assert.equal(noMessages.status, 400);
  assert.equal(noMessages.json.error.code, 'invalid_messages');
});

test('streaming returns SSE chunks and [DONE]', async (t) => {
  const { base } = await startBridge(t, {
    upstreamOptions: {
      message: () => ({
        status: 200,
        body: {
          info: { tokens: { input: 3, output: 5, total: 8 }, finish: 'stop' },
          parts: [{ type: 'text', text: 'Hello streaming world' }],
        },
      }),
    },
  });
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'b-free', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = await readSse(res);
  assert.equal(events.at(-1), '[DONE]');
  const content = events
    .slice(1, -2)
    .map((e) => e.choices?.[0]?.delta?.content ?? '')
    .join('');
  assert.equal(content, 'Hello streaming world');
  const final = events.at(-2);
  assert.equal(final.choices[0].finish_reason, 'stop');
  const first = events[0];
  assert.equal(first.object, 'chat.completion.chunk');
  assert.equal(first.choices[0].delta.role, 'assistant');
});

test('upstream 401 maps to an authentication error without leaking credentials', async (t) => {
  const { base } = await startBridge(t, {
    upstreamOptions: {
      message: () => ({ status: 401, body: { error: { message: 'bad bearer token sk-supersecret123456' } } }),
    },
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.type, 'authentication_error');
  assert.equal(JSON.stringify(res.json).includes('supersecret'), false);
});

test('upstream 429 preserves the status and maps to rate_limit_error', async (t) => {
  const { base } = await startBridge(t, {
    env: { UPSTREAM_RETRIES: '0' },
    upstreamOptions: {
      message: () => ({ status: 429, body: { message: 'slow down' } }),
    },
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 429);
  assert.equal(res.json.error.type, 'rate_limit_error');
  assert.equal(res.json.error.code, 'rate_limit_exceeded');
});

test('assistant errors inside HTTP 200 fail JSON and streaming completions', async (t) => {
  const { base, up } = await startBridge(t, {
    upstreamOptions: {
      message: () => ({
        status: 200,
        body: {
          info: { error: { name: 'APIError', data: { statusCode: 403, message: 'Network blocked: bearer secret123456' } } },
          parts: [],
        },
      }),
    },
  });
  const body = { model: 'a-free', messages: [{ role: 'user', content: 'x' }] };
  const json = await httpJson(`${base}/v1/chat/completions`, { method: 'POST', body });
  assert.equal(json.status, 403);
  assert.equal(json.json.error.code, 'upstream_forbidden');
  assert.equal(json.text.includes('secret123456'), false);
  assert.equal(json.json.choices, undefined);

  const stream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const events = await readSse(stream);
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(events.at(-2).error.code, 'upstream_forbidden');
  assert.equal(events.some(e => e.choices?.[0]?.finish_reason === 'stop'), false);
  assert.equal(up.state.messageCounts['a-free'], 2, 'forbidden errors must not be retried');
  await waitFor(() => up.state.sessions.size === 0, { what: 'failed session cleanup' });
});

test('embedded retryable assistant errors recover with a fresh session', async (t) => {
  const { base, up } = await startBridge(t, {
    env: { UPSTREAM_RETRIES: '1' },
    upstreamOptions: {
      messageQueue: {
        'a-free': [
          { status: 200, body: { info: { error: { name: 'APIError', data: { statusCode: 503, message: 'try later' } } }, parts: [] } },
          { status: 200 },
        ],
      },
    },
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST', body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.choices[0].message.content, 'echo:a-free');
  assert.equal(up.state.sessionSeq, 2);
});

test('assistant errors without a valid HTTP error status map to 502', async (t) => {
  const { base } = await startBridge(t, {
    env: { UPSTREAM_RETRIES: '0' },
    upstreamOptions: {
      message: () => ({ status: 200, body: { info: { error: { name: 'UnknownError', data: { statusCode: 200 } } }, parts: [] } }),
    },
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST', body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, 'upstream_error');
});

test('upstream 500 includes the upstream ref id and preserves the status', async (t) => {
  const { base } = await startBridge(t, {
    env: { UPSTREAM_RETRIES: '0' },
    upstreamOptions: {
      message: () => ({
        status: 500,
        body: { name: 'UnknownError', data: { message: 'Unexpected server error.', ref: 'err_40d4ce91' } },
      }),
    },
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 500);
  assert.equal(res.json.error.type, 'api_error');
  assert.equal(res.json.error.code, 'upstream_error');
  assert.match(res.json.error.message, /err_40d4ce91/);
});

test('transient 500s are retried with bounded attempts and a fresh session', async (t) => {
  const { base, up } = await startBridge(t, {
    env: { UPSTREAM_RETRIES: '2' },
    upstreamOptions: {
      messageQueue: {
        'a-free': [
          { status: 500, body: { name: 'UnknownError', data: { message: 'boom', ref: 'err_1' } } },
          { status: 500, body: { name: 'UnknownError', data: { message: 'boom', ref: 'err_2' } } },
          { status: 200, body: { info: { tokens: { input: 1, output: 1, total: 2 }, finish: 'stop' }, parts: [{ type: 'text', text: 'recovered' }] } },
        ],
      },
    },
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.choices[0].message.content, 'recovered');
  assert.equal(up.state.messageCounts['a-free'], 3);
  assert.equal(up.state.sessionSeq, 3, 'each retry uses a fresh session');
});

test('upstream timeouts map to 504 without hanging the request', async (t) => {
  const { base } = await startBridge(t, {
    env: { UPSTREAM_TIMEOUT_MS: '300', UPSTREAM_RETRIES: '0' },
    upstreamOptions: { message: () => 'hang' },
  });
  const started = Date.now();
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 504);
  assert.equal(res.json.error.code, 'upstream_timeout');
  assert.ok(Date.now() - started < 3000);
});

test('shared session mode recovers when the upstream session disappears', async (t) => {
  const { base, up } = await startBridge(t, {
    env: { SESSION_MODE: 'shared', UPSTREAM_RETRIES: '1' },
    upstreamOptions: {
      message: ({ sessionId }) => (sessionId === 'ses_mock_1' ? { status: 404, body: { name: 'NotFound' } } : { status: 200 }),
    },
  });
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 200);
  assert.ok(up.state.sessionSeq >= 2);
});

test('per-request sessions are cleaned up after the response', async (t) => {
  const { base, up } = await startBridge(t);
  await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  await waitFor(() => up.state.sessions.size === 0, { timeoutMs: 3000, what: 'session cleanup' });
});

test('hot reload: registry file changes are served without a restart', async (t) => {
  const { base, temp, up } = await startBridge(t, { models: ['a-free'] });
  const before = await httpJson(`${base}/v1/models`);
  assert.deepEqual(before.json.data.slice(1).map((m) => m.id), ['a-free']);

  await new Promise((r) => setTimeout(r, 20));
  writeRegistry(temp.dir, ['a-free', 'hot-added-free']);
  const after = await waitFor(async () => {
    const res = await httpJson(`${base}/v1/models`);
    return res.json.data.length === 3 ? res : null;
  }, { timeoutMs: 5000, what: 'hot reload' });
  assert.deepEqual(after.json.data.slice(1).map((m) => m.id), ['a-free', 'hot-added-free']);

  const chat = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'hot-added-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.model, 'hot-added-free');
  assert.ok(up.state.messageCounts['hot-added-free'] >= 1);
});

test('GET /health reports upstream connectivity and sync state', async (t) => {
  const { base } = await startBridge(t, { env: { MODEL_AUTO_SYNC: 'true' } });
  const res = await httpJson(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
  assert.equal(res.json.upstream, 'connected');
  assert.equal(res.json.modelSync, 'enabled');
  assert.equal(res.json.modelCount, 2);
  assert.equal(typeof res.json.registryHash, 'string');
  assert.equal(typeof res.json.version, 'string');
});

test('GET /health degrades when the upstream health check hangs', async (t) => {
  const { base } = await startBridge(t, {
    env: { HEALTH_UPSTREAM_TIMEOUT_MS: '250' },
    upstreamOptions: { health: () => 'hang' },
  });
  const res = await httpJson(`${base}/health`, { });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'degraded');
  assert.equal(res.json.upstream, 'disconnected');
});

test('GET /healthz stays backwards compatible', async (t) => {
  const { base, up } = await startBridge(t);
  const res = await httpJson(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.upstream, up.url);
  assert.equal(res.json.free, 2);
});

test('bridge recovers models after restart', async (t) => {
  const first = await startBridge(t, { models: ['persist-free'] });
  const before = await httpJson(`${first.base}/v1/models`);
  assert.deepEqual(before.json.data.slice(1).map((m) => m.id), ['persist-free']);
  await first.bridge.close();

  const second = await startBridge(t, { models: ['ignored-free'] });
  const registry = new ModelRegistry({ paths: first.config.paths, logger: silent });
  registry.load();
  const config = { ...first.config, port: 0, upstream: second.up.url };
  const bridge = createBridgeServer({ config, registry, logger: silent });
  await bridge.listen(0, '127.0.0.1');
  t.after(() => bridge.close());
  const after = await httpJson(`http://127.0.0.1:${bridge.port}/v1/models`);
  assert.deepEqual(after.json.data.slice(1).map((m) => m.id), ['persist-free']);
});

test('non-loopback clients are rejected', async (t) => {
  const { base } = await startBridge(t);
  const port = Number(new URL(base).port);
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/models', localAddress: '127.0.0.2' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 403);
});

test('unknown routes return OpenAI-shaped 404s', async (t) => {
  const { base } = await startBridge(t);
  const res = await httpJson(`${base}/v1/unknown`);
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'invalid_request_error');
});
