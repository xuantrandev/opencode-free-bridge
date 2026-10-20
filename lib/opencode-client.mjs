// Thin client for the local `opencode serve` REST API.

import { fetchWithRetry } from './upstream.mjs';

export class OpenCodeClient {
  constructor({
    upstream,
    provider = 'opencode',
    agent = 'general',
    timeoutMs = 300_000,
    connectTimeoutMs = 10_000,
    retries = 2,
    retryBaseMs = 500,
    fetchImpl = globalThis.fetch,
    logger = null,
  } = {}) {
    this.upstream = String(upstream).replace(/\/+$/, '');
    this.provider = provider;
    this.agent = agent;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.retries = retries;
    this.retryBaseMs = retryBaseMs;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  get authHeaders() {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return {};
    const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  }

  // Cheap connectivity probe. Never triggers inference.
  async health({ timeoutMs = 2000 } = {}) {
    const started = Date.now();
    for (const path of ['/global/health', '/config']) {
      const res = await fetchWithRetry(`${this.upstream}${path}`, {
        method: 'GET',
        headers: this.authHeaders,
        timeoutMs,
        retries: 0,
        fetchImpl: this.fetchImpl,
        logger: this.logger,
        label: 'health',
      });
      if (res.ok) {
        return { ok: true, latencyMs: Date.now() - started, path, version: res.json?.version ?? null };
      }
      if (res.status === 404) continue; // older opencode without /global/health
      return { ok: false, latencyMs: Date.now() - started, status: res.status, error: res.error ?? null, path };
    }
    return { ok: false, latencyMs: Date.now() - started, status: 0, error: null, path: null };
  }

  async createSession({ timeoutMs = this.connectTimeoutMs } = {}) {
    return fetchWithRetry(`${this.upstream}/session`, {
      method: 'POST',
      headers: this.authHeaders,
      body: '{}',
      timeoutMs,
      retries: 0,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
      label: 'session.create',
    });
  }

  async deleteSession(sessionId, { timeoutMs = 2000 } = {}) {
    if (!sessionId) return { ok: false, status: 0 };
    return fetchWithRetry(`${this.upstream}/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: this.authHeaders,
      timeoutMs,
      retries: 0,
      fetchImpl: this.fetchImpl,
      logger: null,
      label: 'session.delete',
    });
  }

  /**
   * POST /session/{id}/message — the only call that triggers inference.
   * `res.body.model` etc. are passed through. Retries are bounded and reuse a
   * freshly created session (the caller invalidates `sessionId` via
   * `onRetrySession`).
   */
  async sendMessage(sessionId, { model, parts, agent = this.agent, timeoutMs = this.timeoutMs, retries = this.retries, noReply = false } = {}) {
    const result = await fetchWithRetry(`${this.upstream}/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({
        model: { providerID: this.provider, modelID: model },
        agent,
        parts,
        ...(noReply ? { noReply: true } : {}),
      }),
      timeoutMs,
      retries,
      retryBaseMs: this.retryBaseMs,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
      label: `message(${model})`,
    });
    // OpenCode can return HTTP 200 with an assistant error and no text parts.
    // Normalize it here so completions and verification both see the failure.
    const error = result.json?.info?.error;
    if (!result.ok || !error) return result;
    const status = error.data?.statusCode;
    const headers = { ...result.headers };
    for (const name of ['retry-after', 'x-request-id']) {
      const value = error.data?.responseHeaders?.[name];
      if (typeof value === 'string') headers[name] = value;
    }
    return {
      ...result,
      ok: false,
      status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
      headers,
      json: error,
    };
  }
}

export function extractText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
}
