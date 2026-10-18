// HTTP-based model discovery through the internal discovery agent that runs
// next to `opencode serve` (see docker/opencode-agent.mjs).
//
// The bridge container cannot execute the `opencode` CLI in the upstream
// container, so discovery commands are proxied over the Docker-internal
// network to the agent, which runs them locally and returns the raw CLI
// output. Parsing/classification stays in lib/discovery.mjs so both modes
// (local CLI exec + remote agent) share exactly the same logic.

const SUPPORTED_ARGS = new Set(['models', '--verbose']);

/**
 * Build a runner compatible with `discoverModels({ runner })`.
 *
 * The agent exposes:
 *   GET /models?provider=<p>[&verbose=1]
 *     -> { ok: true, code: 0, stdout, stderr, durationMs }
 *     -> { ok: false, kind: 'timeout'|'exit', code, stdout, stderr }
 *
 * Return shape mirrors lib/discovery.mjs `defaultRunner`:
 *   { ok, kind?, code?, stdout, stderr, message? }
 */
export function createAgentRunner({
  url,
  token = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  fetchRetries = 1,
  retryBaseMs = 300,
  logger = null,
} = {}) {
  if (!url) throw new Error('createAgentRunner requires a discovery agent url');
  const base = String(url).replace(/\/+$/, '');

  return async function agentRunner({ args = [], timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    for (const arg of args) {
      if (arg.startsWith('-') && !SUPPORTED_ARGS.has(arg)) {
        return { ok: false, kind: 'unsupported', code: null, stdout: '', stderr: '', message: `discovery agent does not support '${arg}'` };
      }
    }
    if (args[0] !== 'models') {
      return { ok: false, kind: 'unsupported', code: null, stdout: '', stderr: '', message: `discovery agent does not support '${args.join(' ')}'` };
    }

    const provider = args[1] || 'opencode';
    const verbose = args.includes('--verbose');
    const qs = new URLSearchParams({ provider });
    if (verbose) qs.set('verbose', '1');
    const target = `${base}/models?${qs.toString()}`;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const attempts = Math.max(1, fetchRetries + 1);
    let lastFailure = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        logger?.debug?.('retrying discovery agent request', { attempt, url: base });
        await new Promise((r) => setTimeout(r, retryBaseMs * attempt));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(callTimeoutMs, 1));
      try {
        const res = await fetchImpl(target, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            kind: 'auth',
            code: res.status,
            stdout: '',
            stderr: '',
            message: `discovery agent rejected the request (HTTP ${res.status}); check DISCOVERY_TOKEN`,
          };
        }
        if (!res.ok || !json || typeof json !== 'object') {
          lastFailure = {
            ok: false,
            kind: res.status === 429 ? 'busy' : 'exit',
            code: res.status,
            stdout: '',
            stderr: String(json?.error ?? text ?? '').slice(0, 500),
            message: `discovery agent HTTP ${res.status}`,
          };
          if (res.status >= 500 && attempt < attempts - 1) continue;
          return lastFailure;
        }
        if (json.ok === false) {
          return {
            ok: false,
            kind: json.kind === 'timeout' ? 'timeout' : 'exit',
            code: typeof json.code === 'number' ? json.code : null,
            stdout: String(json.stdout ?? ''),
            stderr: String(json.stderr ?? '').slice(0, 500),
            message: json.error || `discovery agent reported failure`,
          };
        }
        return { ok: true, code: 0, stdout: String(json.stdout ?? ''), stderr: String(json.stderr ?? '') };
      } catch (err) {
        const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError' || controller.signal.aborted;
        lastFailure = {
          ok: false,
          kind: aborted ? 'timeout' : 'network',
          code: null,
          stdout: '',
          stderr: '',
          message: aborted
            ? `discovery agent request timed out after ${callTimeoutMs}ms`
            : `discovery agent unreachable at ${base}: ${err?.code || err?.message || err}`,
        };
        if (!aborted && attempt < attempts - 1) continue;
        return lastFailure;
      } finally {
        clearTimeout(timer);
      }
    }
    return lastFailure ?? { ok: false, kind: 'network', code: null, stdout: '', stderr: '', message: 'discovery agent unreachable' };
  };
}

/** Probe the discovery agent's /health endpoint. Never triggers inference. */
export async function agentHealth({ url, token = '', fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  if (!url) return { ok: false, status: 0, json: null };
  const base = String(url).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
  try {
    const res = await fetchImpl(`${base}/health`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok && json?.ok !== false, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}
