import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeClient } from '../lib/opencode-client.mjs';
import { createUpstreamTest } from '../lib/verify.mjs';
import { startMockUpstream, waitFor } from './helpers.mjs';

test('verification rejects assistant errors returned with HTTP 200', async (t) => {
  const up = await startMockUpstream({
    message: () => ({
      status: 200,
      body: {
        info: { error: { name: 'APIError', data: { statusCode: 403, message: 'Free tier network blocked' } } },
        parts: [],
      },
    }),
  });
  t.after(() => up.close());
  const probe = createUpstreamTest({ client: new OpenCodeClient({ upstream: up.url }) });
  const result = await probe({ id: 'a-free', timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'http');
  assert.match(result.error, /HTTP 403/);
  await waitFor(() => up.state.sessions.size === 0, { what: 'verification session cleanup' });
});
