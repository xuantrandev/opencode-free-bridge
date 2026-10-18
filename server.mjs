#!/usr/bin/env node
// OpenAI-compatible reverse proxy for the free models exposed by `opencode serve`.
// No API key. No external exposure — the proxy only listens on the loopback interface.
//
// The model list is dynamic: it comes from config/models.json, which is kept up
// to date by the discovery/sync service (lib/sync.mjs) and hot-reloaded without
// restarting the process.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { createLogger } from './lib/logger.mjs';
import { ModelRegistry, registryHash } from './lib/registry.mjs';
import { OpenCodeClient, extractText } from './lib/opencode-client.mjs';
import { mapUpstreamError, openaiErrorBody, sanitizeMessage } from './lib/upstream.mjs';
import { ModelSyncService } from './lib/sync.mjs';
import { ensureDir } from './lib/fsutil.mjs';
import { VERSION } from './lib/version.mjs';

const SYSTEM_DEFAULT = 'You are a helpful assistant.';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Constant-time string comparison (hashed first so lengths never leak). */
export function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function extractBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function jsonResponse(res, status, body, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

function sseWrite(res, data) {
  if (typeof data === 'string') res.write(`data: ${data}\n\n`);
  else res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || p.type === undefined) && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

/**
 * Convert an OpenAI messages array into opencode message parts. With history
 * enabled (default) earlier turns are preserved, which matches OpenAI's
 * stateless semantics.
 */
export function partsFromOpenAIMessages(messages, { includeHistory = true, systemDefault = SYSTEM_DEFAULT } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const systemText = list.filter((m) => m?.role === 'system').map((m) => contentToText(m.content)).filter(Boolean).join('\n\n');
  const turns = list.filter((m) => m?.role !== 'system');
  if (turns.length === 0) throw Object.assign(new Error('messages must contain at least one user message'), { code: 'bad_request' });

  if (!includeHistory) {
    const lastUser = [...turns].reverse().find((m) => m.role === 'user');
    if (!lastUser) throw Object.assign(new Error('no user message'), { code: 'bad_request' });
    const text = contentToText(lastUser.content);
    const prefixes = systemText ? `[system]\n${systemText}\n\n[user]\n` : '';
    return { parts: [{ type: 'text', text: prefixes + text }], system: systemText };
  }

  const sections = [];
  if (systemText) sections.push(`[system]\n${systemText}`);
  for (const m of turns) {
    const text = contentToText(m?.content);
    if (!text && m?.role !== 'assistant') continue;
    const label = m?.role === 'assistant' ? '[assistant]' : m?.role === 'tool' ? '[tool]' : '[user]';
    sections.push(`${label}\n${text}`);
  }
  return { parts: [{ type: 'text', text: sections.join('\n\n') }], system: systemText };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createBridgeServer({
  config,
  registry,
  logger = createLogger({ level: config.logLevel, file: config.logFile }),
  client = null,
  syncService = null,
  fetchImpl = globalThis.fetch,
  watch = false,
} = {}) {
  const oc = client ?? new OpenCodeClient({
    upstream: config.upstream,
    provider: config.provider,
    agent: config.agent,
    timeoutMs: config.upstreamTimeoutMs,
    connectTimeoutMs: config.upstreamConnectTimeoutMs,
    retries: config.upstreamRetries,
    retryBaseMs: config.upstreamRetryBaseMs,
    fetchImpl,
    logger,
  });

  const startedAt = Date.now();
  let sharedSessionId = null;
  let sharedSessionLock = null;
  let upstreamCache = { at: 0, result: null };
  const inflight = new Set();
  const maxBodyBytes = Math.max(1024, config.requestBodyLimitBytes ?? 10 * 1024 * 1024);
  const rateLimitRpm = Math.max(0, config.rateLimitRpm ?? 0);
  const rateBuckets = new Map();

  // ------------------------------------------------------------ security

  function clientAllowed(remote) {
    if (config.allowNonLoopback) return true;
    return LOOPBACK.has(remote);
  }

  function authorized(req) {
    if (!config.apiKey) return true;
    const token = extractBearerToken(req.headers.authorization);
    if (token == null) return false;
    // Never log or echo either value; compare in constant time.
    return constantTimeEqual(token, config.apiKey);
  }

  function checkRateLimit(key) {
    if (!rateLimitRpm) return { ok: true };
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (rateBuckets.size > 10_000) {
        for (const [k, v] of rateBuckets) if (now >= v.resetAt) rateBuckets.delete(k);
      }
      bucket = { count: 0, resetAt: now + 60_000 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > rateLimitRpm) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    return { ok: true, remaining: rateLimitRpm - bucket.count };
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || typeof origin !== 'string') return {};
    const allowed = Array.isArray(config.corsAllowedOrigins) ? config.corsAllowedOrigins : [];
    if (allowed.length === 0) return {};
    if (!allowed.includes(origin) && !allowed.includes('*')) return {};
    return {
      'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    };
  }

  // ------------------------------------------------------------ sessions

  async function createSession(timeoutMs = config.upstreamConnectTimeoutMs) {
    const res = await oc.createSession({ timeoutMs });
    if (res.ok && res.json?.id) return { ok: true, id: res.json.id, result: res };
    return { ok: false, result: res };
  }

  async function acquireSession() {
    if (config.sessionMode === 'per-request') {
      const created = await createSession();
      return created;
    }
    if (sharedSessionId) return { ok: true, id: sharedSessionId, shared: true };
    if (sharedSessionLock) return sharedSessionLock;
    sharedSessionLock = (async () => {
      const created = await createSession();
      if (created.ok) sharedSessionId = created.id;
      sharedSessionLock = null;
      return created;
    })();
    return sharedSessionLock;
  }

  function releaseSession(id, { deleteSession = false } = {}) {
    if (!id) return;
    if (config.sessionMode === 'per-request' || deleteSession) {
      oc.deleteSession(id, { timeoutMs: 2000 }).catch(() => {});
    }
  }

  function invalidateSharedSession(id) {
    if (config.sessionMode === 'shared' && sharedSessionId === id) sharedSessionId = null;
  }

  /**
   * Send one inference request. Bounded retries with exponential backoff for
   * transient upstream failures; each retry uses a fresh session so a retried
   * request never interleaves with a half-processed earlier attempt.
   */
  async function sendWithSession({ modelId, parts }) {
    const maxAttempts = Math.max(1, config.upstreamRetries + 1);
    let lastResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const session = await acquireSession();
      if (!session.ok) {
        lastResult = { ...session.result, phase: 'session' };
        if (attempt >= maxAttempts) break;
        await sleep(retryDelay(config.upstreamRetryBaseMs, attempt, session.result));
        continue;
      }
      const result = await oc.sendMessage(session.id, {
        model: modelId,
        parts,
        timeoutMs: config.upstreamTimeoutMs,
        retries: 0,
      });
      if (result.ok) {
        releaseSession(session.id);
        return result;
      }
      const sessionGone = result.status === 404 && config.sessionMode === 'shared';
      const retryable = isRetryable(result) || sessionGone;
      invalidateSharedSession(session.id);
      if (config.sessionMode === 'per-request') releaseSession(session.id);
      lastResult = result;
      if (!retryable || attempt >= maxAttempts) break;
      logger.debug?.('retrying upstream message', { model: modelId, attempt, status: result.status });
      await sleep(retryDelay(config.upstreamRetryBaseMs, attempt, result));
    }
    return lastResult;
  }

  function isRetryable(result) {
    if (!result) return false;
    if (result.status === 0) return true; // network/timeout
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(result.status);
  }

  function retryDelay(baseMs, attempt, result) {
    if (result?.status === 429 && result.headers?.['retry-after']) {
      const secs = Number(result.headers['retry-after']);
      if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 10) * 1000;
    }
    const backoff = Math.min(baseMs * 2 ** (attempt - 1), 5000);
    return backoff + Math.floor(Math.random() * Math.min(backoff, 250));
  }

  // ------------------------------------------------------------ upstream health

  async function checkUpstream({ force = false } = {}) {
    if (!force && upstreamCache.result && Date.now() - upstreamCache.at < config.healthCacheMs) {
      return upstreamCache.result;
    }
    const result = await oc.health({ timeoutMs: config.healthUpstreamTimeoutMs });
    upstreamCache = { at: Date.now(), result };
    return result;
  }

  // ------------------------------------------------------------ handlers

  function handleListModels(req, res, cors = {}) {
    registry.reloadFromDisk();
    const data = registry.models.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-free',
      context_window: m.context ?? null,
      max_output_tokens: m.output ?? null,
      free: true,
      status: m.status ?? 'discovered',
      verified: m.status === 'verified',
    }));
    jsonResponse(res, 200, { object: 'list', data }, cors);
  }

  function handleGetModel(req, res, id, cors = {}) {
    registry.reloadFromDisk();
    const m = registry.get(id);
    if (!m) return jsonResponse(res, 404, openaiErrorBody(`model '${id}' not found`, 'invalid_request_error', 'model_not_found', 'model'), cors);
    return jsonResponse(res, 200, {
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-free',
      context_window: m.context ?? null,
      max_output_tokens: m.output ?? null,
      free: true,
      status: m.status ?? 'discovered',
    }, cors);
  }

  /**
   * Liveness + rich status. Always HTTP 200 while the process serves; the
   * `status` field degrades when the upstream is unreachable. Never triggers
   * inference (or paid tokens) — only the cheap upstream health probe.
   */
  async function handleHealth(req, res) {
    const upstream = await checkUpstream();
    const sync = syncService ? syncService.getStatus() : null;
    const hash = registryHash(registry.models);
    const registryOk = registry.loadedFrom !== null;
    jsonResponse(res, 200, {
      status: upstream.ok ? 'ok' : 'degraded',
      ok: true,
      bridge: {
        ok: true,
        version: VERSION,
        pid: process.pid,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        startedAt: new Date(startedAt).toISOString(),
      },
      upstream: upstream.ok ? 'connected' : 'disconnected',
      upstreamDetail: {
        ok: upstream.ok,
        latencyMs: upstream.latencyMs ?? null,
        version: upstream.version ?? null,
        checkedPath: upstream.path ?? null,
      },
      upstreamLatencyMs: upstream.latencyMs ?? null,
      upstreamVersion: upstream.version ?? null,
      registry: {
        ok: registryOk,
        empty: registry.models.length === 0,
        source: registry.loadedFrom ? path.basename(registry.loadedFrom) : null,
        loadedFrom: registry.loadedFrom,
        generation: registry.registry.generation ?? 0,
        hash,
        models: registry.models.length,
        verified: registry.models.filter((m) => m.status === 'verified').length,
        discovered: registry.models.filter((m) => m.status === 'discovered').length,
        lastUpdated: registry.registry.lastUpdated ?? null,
      },
      modelSync: config.autoSync ? 'enabled' : 'disabled',
      modelSyncDetail: sync ?? {
        enabled: false,
        running: false,
        intervalMinutes: config.syncIntervalMinutes,
      },
      discovery: {
        mode: sync?.discoveryMode ?? (config.discoveryUrl ? 'agent' : 'cli'),
        url: config.discoveryUrl || null,
      },
      modelCount: registry.models.length,
      modelCountVerified: registry.models.filter((m) => m.status === 'verified').length,
      lastSync: registry.registry.lastSync,
      lastSyncStatus: registry.registry.lastSyncStatus ?? null,
      lastSyncError: registry.registry.lastSyncError ?? null,
      lastSyncResult: sync?.lastResult ?? null,
      registryHash: hash,
      generation: registry.registry.generation ?? 0,
      sessionMode: config.sessionMode,
      nextSyncAt: sync?.nextRunAt ?? null,
      syncRunning: sync?.running ?? false,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: VERSION,
    });
  }

  /**
   * Readiness: 200 only when the bridge can actually serve chat requests —
   * the registry has models and the upstream is reachable. Returns 503
   * otherwise so orchestrators stop routing traffic without flapping healthy
   * containers during a temporary provider outage (liveness stays /health).
   */
  async function handleReady(req, res) {
    const upstream = await checkUpstream();
    const registryOk = registry.models.length > 0;
    const ready = upstream.ok && registryOk;
    jsonResponse(res, ready ? 200 : 503, {
      ready,
      status: ready ? 'ready' : 'not-ready',
      checks: {
        bridge: true,
        registry: registryOk,
        upstream: upstream.ok,
      },
      modelCount: registry.models.length,
      registryHash: registryHash(registry.models),
      lastSync: registry.registry.lastSync,
      lastSyncStatus: registry.registry.lastSyncStatus ?? null,
      upstreamLatencyMs: upstream.latencyMs ?? null,
      version: VERSION,
    });
  }

  function handleHealthz(req, res) {
    const upstream = upstreamCache.result;
    jsonResponse(res, 200, {
      ok: true,
      upstream: config.upstream,
      upstreamConnected: upstream ? upstream.ok : null,
      free: registry.models.length,
      version: VERSION,
    });
  }

  function rejectOversizedBody(req, res, cors) {
    req.on('error', () => {});
    if (!res.writableEnded) {
      jsonResponse(res, 413, openaiErrorBody('request body too large', 'invalid_request_error', 'payload_too_large'), cors);
    }
    req.resume();
  }

  async function handleChatCompletions(req, res, cors = {}) {
    let raw = '';
    let size = 0;
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return rejectOversizedBody(req, res, cors);
    }
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          return rejectOversizedBody(req, res, cors);
        }
        raw += chunk;
      }
    } catch {
      if (!res.headersSent) return jsonResponse(res, 400, openaiErrorBody('failed to read request body', 'invalid_request_error', 'invalid_body'), cors);
      return res.end();
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonResponse(res, 400, openaiErrorBody('invalid JSON in request body', 'invalid_request_error', 'invalid_json'), cors);
    }
    if (!body || typeof body !== 'object') {
      return jsonResponse(res, 400, openaiErrorBody('request body must be a JSON object'), cors);
    }

    registry.reloadFromDisk();
    if (!body.model || typeof body.model !== 'string') {
      return jsonResponse(res, 400, openaiErrorBody("you must provide a 'model' parameter", 'invalid_request_error', 'missing_model', 'model'), cors);
    }
    if (!registry.has(body.model)) {
      const available = registry.models.map((m) => m.id).slice(0, 50).join(', ');
      return jsonResponse(res, 404, openaiErrorBody(
        `model '${body.model}' does not exist or is not supported by this bridge. available: ${available || '(none)'}`,
        'invalid_request_error',
        'model_not_found',
        'model',
      ), cors);
    }

    let parts;
    try {
      ({ parts } = partsFromOpenAIMessages(body.messages, {
        includeHistory: config.includeHistory,
        systemDefault: SYSTEM_DEFAULT,
      }));
    } catch (err) {
      return jsonResponse(res, 400, openaiErrorBody(err?.message || 'invalid messages', 'invalid_request_error', 'invalid_messages'), cors);
    }

    const stream = body.stream === true;
    const requestId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    inflight.add(requestId);
    try {
      if (!stream) return await handleNonStreaming(res, { body, parts, requestId, cors });
      return await handleStreaming(res, { body, parts, requestId });
    } finally {
      inflight.delete(requestId);
    }
  }

  async function handleNonStreaming(res, { body, parts, requestId, cors = {} }) {
    const result = await sendWithSession({ modelId: body.model, parts });
    if (!result.ok) {
      const mapped = mapUpstreamError(result, { model: body.model, logger });
      return jsonResponse(res, mapped.status, mapped.body, cors);
    }
    if (!result.json || typeof result.json !== 'object') {
      return jsonResponse(res, 502, openaiErrorBody('malformed upstream response', 'api_error', 'upstream_malformed'), cors);
    }
    const info = result.json.info ?? {};
    const text = extractText(result.json.parts);
    const usage = info.tokens ?? {};
    jsonResponse(res, 200, {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: info.finish || 'stop',
      }],
      usage: {
        prompt_tokens: usage.input || 0,
        completion_tokens: usage.output || 0,
        total_tokens: usage.total || ((usage.input || 0) + (usage.output || 0)),
      },
    }, cors);
  }

  async function handleStreaming(res, { body, parts, requestId }) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finishReason = null, extra = {}) => ({
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    });

    sseWrite(res, chunk({ role: 'assistant' }));
    const result = await sendWithSession({ modelId: body.model, parts });
    if (!result.ok) {
      const mapped = mapUpstreamError(result, { model: body.model, logger });
      sseWrite(res, { error: mapped.body.error });
      sseWrite(res, '[DONE]');
      return res.end();
    }
    const info = result.json?.info ?? {};
    const text = extractText(result.json?.parts);
    const pieces = text.match(/[\s\S]{1,30}/g) || [];
    for (const piece of pieces) sseWrite(res, chunk({ content: piece }));
    const usage = info.tokens ?? {};
    sseWrite(res, chunk({}, info.finish || 'stop', {
      usage: {
        prompt_tokens: usage.input || 0,
        completion_tokens: usage.output || 0,
        total_tokens: usage.total || ((usage.input || 0) + (usage.output || 0)),
      },
    }));
    sseWrite(res, '[DONE]');
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress;
    if (!clientAllowed(remote)) {
      return jsonResponse(res, 403, openaiErrorBody('loopback only', 'permission_error', 'forbidden'));
    }
    let url;
    try {
      url = new URL(req.url, `http://${config.host}:${config.port || 0}`);
    } catch {
      return jsonResponse(res, 400, openaiErrorBody('bad request url'));
    }

    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }

    const isV1 = url.pathname === '/v1' || url.pathname.startsWith('/v1/');
    if (isV1) {
      if (!authorized(req)) {
        return jsonResponse(
          res,
          401,
          openaiErrorBody('missing or invalid API key', 'authentication_error', 'invalid_api_key'),
          { 'WWW-Authenticate': 'Bearer', ...cors },
        );
      }
      const limit = checkRateLimit(remote);
      if (!limit.ok) {
        return jsonResponse(
          res,
          429,
          openaiErrorBody(`rate limit exceeded (${rateLimitRpm} requests/minute); retry later`, 'rate_limit_error', 'rate_limit_exceeded'),
          { 'Retry-After': String(limit.retryAfter), ...cors },
        );
      }
    }

    try {
      if (url.pathname === '/v1/models' && req.method === 'GET') return handleListModels(req, res, cors);
      const modelMatch = /^\/v1\/models\/([^/]+)$/.exec(url.pathname);
      if (modelMatch && req.method === 'GET') return handleGetModel(req, res, decodeURIComponent(modelMatch[1]), cors);
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return await handleChatCompletions(req, res, cors);
      if (url.pathname === '/health' && req.method === 'GET') return await handleHealth(req, res);
      if (url.pathname === '/health/ready' && req.method === 'GET') return await handleReady(req, res);
      if (url.pathname === '/healthz' && req.method === 'GET') return handleHealthz(req, res);
      return jsonResponse(res, 404, openaiErrorBody('not found', 'invalid_request_error', 'not_found'));
    } catch (err) {
      logger.error?.('unhandled request error', { path: url.pathname, error: sanitizeMessage(err?.message || err) });
      if (!res.headersSent) {
        return jsonResponse(res, 500, openaiErrorBody('internal bridge error', 'api_error', 'internal_error'));
      }
      try {
        sseWrite(res, { error: openaiErrorBody('internal bridge error', 'api_error', 'internal_error').error });
        sseWrite(res, '[DONE]');
        res.end();
      } catch { /* connection already gone */ }
    }
  });

  return {
    server,
    config,
    registry,
    get port() {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : null;
    },
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      syncService?.stop();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    checkUpstream,
    sendWithSession,
  };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, file: config.logFile });
  for (const warning of config.warnings) logger.warn?.('config', { warning });

  const registry = new ModelRegistry({ paths: config.paths, logger });
  const load = registry.load();
  registry.watch();
  logger.info('model registry loaded', {
    source: load.source ? load.source.replace(config.root + '/', '') : '(none)',
    models: registry.models.length,
    excluded: registry.exclusions.exclude,
  });
  if (registry.models.length === 0) {
    logger.warn('registry is empty; waiting for the first successful model sync');
  }

  const client = new OpenCodeClient({
    upstream: config.upstream,
    provider: config.provider,
    agent: config.agent,
    timeoutMs: config.upstreamTimeoutMs,
    connectTimeoutMs: config.upstreamConnectTimeoutMs,
    retries: config.upstreamRetries,
    retryBaseMs: config.upstreamRetryBaseMs,
    logger,
  });

  const syncService = new ModelSyncService({ config, registry, client, logger, selfUrl: `http://127.0.0.1:${config.port}` });
  const bridge = createBridgeServer({ config, registry, logger, client, syncService, watch: false });
  const addr = await bridge.listen();
  const pidFile = path.join(config.paths.runDir, 'bridge.pid');
  try {
    ensureDir(config.paths.runDir);
    fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o644 });
  } catch (err) {
    logger.warn?.('could not write pid file', { file: pidFile, error: err?.message });
  }
  logger.info('listening', {
    url: `http://${config.host}:${addr.port}`,
    upstream: config.upstream,
    models: registry.models.length,
    discovery: syncService.discoveryMode,
    auth: config.apiKey ? 'api-key' : 'none',
    rateLimitRpm: config.rateLimitRpm,
    pid: process.pid,
  });
  logger.info('models', { ids: registry.models.map((m) => m.id) });

  syncService.start();
  if (config.autoDeploy) logger.info('auto-deploy enabled', { intervalMinutes: config.syncIntervalMinutes, healthCheck: config.healthCheck });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      fs.unlinkSync(pidFile);
    } catch { /* already gone */ }
    await bridge.close();
    registry.close();
    logger.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received: reloading registry from disk');
    registry.reloadFromDisk({ force: true });
  });
  process.on('unhandledRejection', (err) => {
    logger.error('unhandled rejection', { error: sanitizeMessage(err?.message || err) });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[opencode-free-bridge] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
