// HTTP plumbing for talking to the local `opencode serve` upstream:
// strict timeouts, bounded retries with exponential backoff, and mapping of
// upstream failures onto OpenAI-compatible error objects.

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class UpstreamError extends Error {
  constructor(message, { kind, status = 0, body = null, attempts = 1, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind; // 'timeout' | 'network' | 'http' | 'parse'
    this.status = status;
    this.body = body;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 10) * 1000;
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 10_000);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch + timeout + bounded retry. Never retries forever: total attempts is
 * `retries + 1` (default retries = 0). Returns a normalized result object;
 * network failures are returned (not thrown) with status 0.
 */
export async function fetchWithRetry(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 30_000,
  retries = 0,
  retryBaseMs = 500,
  fetchImpl = globalThis.fetch,
  logger = null,
  maxRetryDelayMs = 10_000,
  label = 'upstream',
} = {}) {
  const payload = typeof body === 'string' || body == null ? body : JSON.stringify(body);
  const requestHeaders = { ...headers };
  if (payload != null && !('content-type' in requestHeaders) && !('Content-Type' in requestHeaders)) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const attemptsAllowed = Math.max(1, Number(retries) + 1);
  let lastError = null;

  for (let attempt = 0; attempt < attemptsAllowed; attempt++) {
    if (attempt > 0) {
      const retryAfter = lastError?.retryAfterMs;
      const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), maxRetryDelayMs);
      const delay = retryAfter ?? (backoff + Math.floor(Math.random() * Math.min(backoff, 250)));
      logger?.debug?.(`${label} retry`, { attempt, delayMs: delay, reason: lastError?.message });
      await sleep(delay);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
    try {
      const res = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: payload,
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timer);
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      const headerObj = {};
      try {
        for (const [k, v] of res.headers.entries()) headerObj[k.toLowerCase()] = v;
      } catch { /* some mocks have no headers */ }
      const result = {
        ok: res.ok,
        status: res.status,
        headers: headerObj,
        text,
        json,
        attempts: attempt + 1,
      };
      if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < attemptsAllowed - 1) {
        const retryAfterMs = parseRetryAfter(headerObj['retry-after']);
        lastError = new UpstreamError(`${label} HTTP ${res.status}`, {
          kind: 'http',
          status: res.status,
          body: text.slice(0, 2000),
          attempts: attempt + 1,
          retryAfterMs,
        });
        continue;
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError' || controller.signal.aborted;
      const kind = aborted ? 'timeout' : 'network';
      lastError = new UpstreamError(
        aborted ? `${label} timed out after ${timeoutMs}ms` : `${label} network error: ${err?.code || err?.message || err}`,
        { kind, attempts: attempt + 1 },
      );
      if (attempt >= attemptsAllowed - 1) {
        return { ok: false, status: 0, headers: {}, text: '', json: null, attempts: attempt + 1, error: lastError };
      }
    }
  }

  return { ok: false, status: 0, headers: {}, text: '', json: null, attempts: attemptsAllowed, error: lastError };
}

const URL_RX = /https?:\/\/[^\s"'<>]+/gi;
const SECRET_RX = /(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi;
const KEY_RX = /\b(sk|key|token|password|secret)[-_:=][A-Za-z0-9._~+/=-]{8,}/gi;

/** Remove URLs, tokens and other sensitive server details from a message. */
export function sanitizeMessage(message, maxLen = 400) {
  let s = String(message ?? '').replace(URL_RX, '[upstream]').replace(SECRET_RX, '$1[redacted]').replace(KEY_RX, '[redacted]');
  s = s.replace(/[\r\n]+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s;
}

/** Extract the upstream error reference id / request id when present. */
export function extractErrorRef(json, headers = {}) {
  const candidates = [
    json?.data?.ref,
    json?.data?.requestID,
    json?.error?.ref,
    json?.error?.request_id,
    json?.ref,
    json?.requestID,
    headers['x-request-id'],
    headers['x-opencode-ref'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && c.length < 200) return c;
  }
  return null;
}

export function extractUpstreamMessage(json, fallback = '') {
  if (!json || typeof json !== 'object') return fallback;
  return json?.data?.message || json?.error?.message || json?.message || json?.name || fallback;
}

/**
 * Map an upstream failure onto an OpenAI-compatible error response.
 * Returns { status, body: { error: { message, type, param, code } }, log }.
 * The log object is meant for server-side logging only and may contain the ref.
 */
export function mapUpstreamError(result, { model = null, logger = null } = {}) {
  const status = result?.status || 0;
  const json = result?.json;
  const headers = result?.headers || {};
  const err = result?.error;
  const ref = extractErrorRef(json, headers);
  const rawMessage = extractUpstreamMessage(json, err?.message || 'upstream error');
  const message = sanitizeMessage(rawMessage);
  const refSuffix = ref ? ` (ref: ${ref})` : '';
  const log = { status, ref, kind: err?.kind || 'http', message, model };

  let out;
  if (status === 0 && err?.kind === 'timeout') {
    out = { status: 504, error: { message: `Upstream timed out while processing the request${refSuffix}`, type: 'api_error', param: null, code: 'upstream_timeout' } };
  } else if (status === 0) {
    out = { status: 502, error: { message: 'Upstream is unreachable', type: 'api_error', param: null, code: 'upstream_unreachable' } };
  } else if (status === 400) {
    out = { status: 400, error: { message: `Upstream rejected the request: ${message}${refSuffix}`, type: 'invalid_request_error', param: null, code: 'upstream_bad_request' } };
  } else if (status === 401) {
    out = { status: 401, error: { message: 'Upstream authentication failed. Check the local OpenCode credentials.', type: 'authentication_error', param: null, code: 'upstream_authentication_failed' } };
  } else if (status === 403) {
    out = { status: 403, error: { message: 'Upstream denied access to this model or endpoint.', type: 'permission_error', param: null, code: 'upstream_forbidden' } };
  } else if (status === 404) {
    out = { status: 404, error: { message: `Model '${model ?? 'unknown'}' is not available upstream${refSuffix}`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } };
  } else if (status === 408 || status === 504) {
    out = { status: 504, error: { message: `Upstream timed out while processing the request${refSuffix}`, type: 'api_error', param: null, code: 'upstream_timeout' } };
  } else if (status === 429) {
    const retryAfter = parseRetryAfter(headers['retry-after']);
    out = {
      status: 429,
      error: {
        message: `Upstream rate limit reached. Retry later${retryAfter ? ` (after ${Math.ceil(retryAfter / 1000)}s)` : ''}.`,
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded',
      },
      retryAfterMs: retryAfter,
    };
  } else if (status >= 500) {
    out = { status, error: { message: `Upstream server error${refSuffix}`, type: 'api_error', param: null, code: 'upstream_error' } };
  } else {
    out = { status: status || 502, error: { message: `Upstream error: ${message}${refSuffix}`, type: 'api_error', param: null, code: 'upstream_error' } };
  }

  out.body = { error: out.error };
  out.log = log;
  if (logger) logger.error?.('upstream error', log);
  return out;
}

export function openaiErrorBody(message, type = 'invalid_request_error', code = null, param = null) {
  return { error: { message, type, param, code } };
}
