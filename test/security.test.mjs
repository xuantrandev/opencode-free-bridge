// API gateway security: optional bearer key (constant-time compare), rate
// limiting, body limits, CORS defaults and the loopback/non-loopback policy.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { constantTimeEqual, extractBearerToken } from '../server.mjs';
import { httpJson, startBridgeServer } from './helpers.mjs';

test('constantTimeEqual and extractBearerToken behave correctly', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('a', 'ab'), false);
  assert.equal(extractBearerToken('Bearer ks-123'), 'ks-123');
  assert.equal(extractBearerToken('bearer   spaced-token'), 'spaced-token');
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken(undefined), null);
});

test('BRIDGE_API_KEY protects /v1/* with an OpenAI-shaped 401', async (t) => {
  const { base, up } = await startBridgeServer(t, { env: { BRIDGE_API_KEY: 'secret-key' } });

  const missing = await httpJson(`${base}/v1/models`);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers['www-authenticate'], 'Bearer');
  assert.equal(missing.json.error.type, 'authentication_error');
  assert.equal(missing.json.error.code, 'invalid_api_key');

  const wrong = await httpJson(`${base}/v1/models`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);

  const chat = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(chat.status, 401);
  assert.equal(up.state.calls.some((c) => c.url.endsWith('/message')), false, 'unauthenticated requests never reach inference');

  const ok = await httpJson(`${base}/v1/models`, { headers: { Authorization: 'Bearer secret-key' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.length, 3);

  // Health probes stay open (Docker healthcheck) but never leak secrets.
  const health = await httpJson(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(JSON.stringify(health.json).includes('secret-key'), false);
});

test('rate limiting returns 429 with Retry-After and spares /health', async (t) => {
  const { base } = await startBridgeServer(t, { env: { RATE_LIMIT_RPM: '3' } });
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await httpJson(`${base}/v1/models`));
  }
  assert.deepEqual(results.slice(0, 3).map((r) => r.status), [200, 200, 200]);
  assert.equal(results[3].status, 429);
  assert.equal(results[3].json.error.type, 'rate_limit_error');
  assert.equal(typeof results[3].headers['retry-after'], 'string');

  const health = await httpJson(`${base}/health`);
  assert.equal(health.status, 200);
});

test('CORS is disabled by default and only allows configured origins', async (t) => {
  const disabled = await startBridgeServer(t);
  const preflight = await httpJson(`${disabled.base}/v1/models`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);

  const enabled = await startBridgeServer(t, { env: { CORS_ALLOWED_ORIGINS: 'http://localhost:3000' } });
  const allowed = await httpJson(`${enabled.base}/v1/models`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');
  const denied = await httpJson(`${enabled.base}/v1/models`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

test('oversized request bodies are rejected with 413', async (t) => {
  const { base } = await startBridgeServer(t, { env: { REQUEST_BODY_LIMIT_BYTES: '2048' } });
  const big = 'x'.repeat(4096);
  const res = await httpJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'a-free', messages: [{ role: 'user', content: big }] },
  });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'payload_too_large');
});

test('non-loopback clients are rejected unless ALLOW_NON_LOOPBACK=true', async (t) => {
  const strict = await startBridgeServer(t);
  const port = Number(new URL(strict.base).port);
  const rejected = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/models', localAddress: '127.0.0.2' }, (r) => {
      r.resume();
      r.on('end', () => resolve(r.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rejected, 403);

  const relaxed = await startBridgeServer(t, { env: { ALLOW_NON_LOOPBACK: 'true' } });
  const relaxedPort = Number(new URL(relaxed.base).port);
  const allowed = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: relaxedPort, path: '/v1/models', localAddress: '127.0.0.2' }, (r) => {
      r.resume();
      r.on('end', () => resolve(r.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(allowed, 200);
});
