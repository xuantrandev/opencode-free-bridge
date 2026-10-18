// Optional inference verification for newly discovered models.
//
// Guardrails:
//  - only called when MODEL_VALIDATE_INFERENCE=true
//  - never tests paid models (callers only pass discovered free models)
//  - strict timeout, limited concurrency, per-run cap, min delay between tests
//  - failing models are not re-tested until a backoff window has elapsed
//  - a global failure (upstream down) never removes models from the registry

import path from 'node:path';
import { atomicWriteJson, readJsonSafe } from './fsutil.mjs';

export const VERIFY_PROMPT = 'Reply with exactly: OK';
export const VERIFY_PROMPT_ALT = 'ping';

export function loadVerificationState(file) {
  const { ok, value } = readJsonSafe(file);
  if (!ok || !value || typeof value !== 'object') return {};
  return value;
}

function isGlobalFailure(results) {
  if (results.length === 0) return false;
  return results.every((r) => r.errorKind === 'network' || r.errorKind === 'timeout');
}

/**
 * Verify a list of model entries. `test` is injectable:
 *   test({ id, timeoutMs }) -> { ok, error?, errorKind? }
 */
export async function verifyModels({
  models,
  test,
  stateFile,
  now = () => Date.now(),
  timeoutMs = 60_000,
  concurrency = 1,
  maxPerRun = 3,
  retryHours = 12,
  delayMs = 250,
  logger = null,
}) {
  const state = loadVerificationState(stateFile);
  const results = [];
  const queue = [];

  for (const model of models) {
    const id = typeof model === 'string' ? model : model.id;
    const prior = state[id] ?? null;
    if (prior?.nextCheckAt && Date.parse(prior.nextCheckAt) > now()) {
      logger?.debug?.('skipping verification (backoff)', { model: id, nextCheckAt: prior.nextCheckAt });
      continue;
    }
    queue.push(id);
    if (queue.length >= maxPerRun) break;
  }

  if (queue.length === 0) {
    return { attempted: 0, results, state, globalFailure: false, skipped: true };
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      const started = now();
      let outcome;
      try {
        outcome = await test({ id, timeoutMs });
      } catch (err) {
        outcome = { ok: false, error: err?.message || String(err), errorKind: err?.kind || 'unknown' };
      }
      const finished = now();
      const prior = state[id] ?? { failCount: 0 };
      const failCount = outcome.ok ? 0 : (prior.failCount || 0) + 1;
      state[id] = {
        status: outcome.ok ? 'verified' : 'failed',
        checkedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        failCount,
        lastError: outcome.ok ? null : String(outcome.error || 'unknown error').slice(0, 300),
        nextCheckAt: outcome.ok
          ? null
          : new Date(finished + retryHours * 3600_000).toISOString(),
      };
      results.push({ id, ...state[id], errorKind: outcome.errorKind ?? null });
      logger?.[outcome.ok ? 'info' : 'warn']?.('model verification', {
        model: id,
        status: state[id].status,
        durationMs: state[id].durationMs,
        error: state[id].lastError || undefined,
      });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker);
  await Promise.all(workers);

  try {
    await atomicWriteJson(stateFile, state);
  } catch (err) {
    logger?.warn?.('could not persist verification state', { error: err?.message });
  }

  const globalFailure = isGlobalFailure(results);
  if (globalFailure) {
    logger?.warn?.('all verification attempts failed with connection errors; treating as global failure and keeping models listed');
  }
  return { attempted: queue.length, results, state, globalFailure, skipped: false };
}

/** Verification probe against the real upstream (or a mock in tests). */
export function createUpstreamTest({ client, detectGlobal = true }) {
  return async function test({ id, timeoutMs }) {
    const session = await client.createSession({ timeoutMs: Math.min(timeoutMs, 10_000) });
    if (!session.ok) {
      return {
        ok: false,
        error: `session create failed (HTTP ${session.status || 'n/a'})`,
        errorKind: session.error?.kind || (session.status === 0 ? 'network' : 'http'),
      };
    }
    const sessionId = session.json?.id;
    try {
      const res = await client.sendMessage(sessionId, {
        model: id,
        parts: [{ type: 'text', text: VERIFY_PROMPT }],
        timeoutMs,
        retries: 0,
      });
      if (!res.ok) {
        const kind = res.error?.kind || 'http';
        return {
          ok: false,
          error: `inference failed (HTTP ${res.status || 'n/a'}${res.json?.data?.ref ? `, ref ${res.json.data.ref}` : ''})`,
          errorKind: kind,
        };
      }
      if (!res.json || typeof res.json !== 'object') {
        return { ok: false, error: 'malformed upstream response', errorKind: 'parse' };
      }
      return { ok: true };
    } finally {
      client.deleteSession(sessionId).catch(() => {});
    }
  };
}

export function verificationSummary(state) {
  const entries = Object.entries(state ?? {});
  return {
    total: entries.length,
    verified: entries.filter(([, v]) => v.status === 'verified').length,
    failed: entries.filter(([, v]) => v.status === 'failed').length,
  };
}

export function verificationStateFile(paths) {
  return paths?.verificationFile ?? path.join('state', 'verification.json');
}
