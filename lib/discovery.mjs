// Model discovery via the local OpenCode CLI.
//
// Primary source:  `opencode models opencode`       (plain list of opencode/<id>)
// Metadata source: `opencode models opencode --verbose` (adds limit/cost JSON)
//
// Free models are only ever those that are provably free:
//   - id ends with "-free"
//   - id is in the built-in KNOWN_FREE_IDS list (e.g. big-pickle)
//   - id is in the admin-controlled include list (config/exclusions.json)
//   - verbose metadata reports cost.input == 0 AND cost.output == 0
// Anything else is rejected, and anything with cost > 0 is treated as paid and
// never added automatically.

import { execFile } from 'node:child_process';
import { matchPattern, matchesAny, parsePatterns } from './config.mjs';

export const KNOWN_FREE_IDS = new Set(['big-pickle']);

export class DiscoveryError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'DiscoveryError';
    this.kind = kind; // 'spawn' | 'timeout' | 'exit' | 'empty' | 'malformed' | 'cli'
  }
}

/** Extract `opencode/<id>` model ids from plain CLI output. */
export function parseModelListOutput(text) {
  const ids = [];
  const seen = new Set();
  let malformed = 0;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(line);
    if (m) {
      const full = `${m[1]}/${m[2]}`;
      if (!seen.has(full)) {
        seen.add(full);
        ids.push(full);
      }
    } else {
      malformed++;
    }
  }
  return { ids, malformed };
}

/** Scan a JSON object starting at `text[start]` ({), tolerating braces in strings. */
function scanBalancedJson(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Parse `opencode models <provider> --verbose` output into
 * Map<fullId, {limit, cost, status, name}>.
 */
export function parseVerboseOutput(text) {
  const out = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const idMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(line);
    if (idMatch) {
      current = `${idMatch[1]}/${idMatch[2]}`;
      continue;
    }
    if (!current || !line) continue;
    const firstBrace = lines[i].indexOf('{');
    if (firstBrace === -1) continue;
    const joined = lines.slice(i).join('\n');
    const scanned = scanBalancedJson(joined, firstBrace);
    if (!scanned) continue;
    try {
      const obj = JSON.parse(scanned.json);
      out.set(current, {
        name: obj.name ?? null,
        status: obj.status ?? null,
        limit: obj.limit ?? null,
        cost: obj.cost ?? null,
      });
      const consumedLines = joined.slice(0, scanned.end).split('\n').length;
      i += consumedLines - 1;
    } catch {
      // skip unparseable block but keep scanning after it
      const consumedLines = joined.slice(0, scanned.end).split('\n').length;
      i += consumedLines - 1;
    }
    current = null;
  }
  return out;
}

export function defaultRunner({ bin = 'opencode', args, timeoutMs, env, cwd }) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
      env,
      cwd,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          kind: error.killed || error.signal === 'SIGKILL' ? 'timeout' : (error.code === 'ENOENT' ? 'spawn' : 'exit'),
          code: typeof error.code === 'number' ? error.code : null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          message: error.message,
        });
        return;
      }
      resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function isZeroCost(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const input = typeof cost.input === 'number' ? cost.input : null;
  const output = typeof cost.output === 'number' ? cost.output : null;
  if (input === null && output === null) return null;
  return (input ?? 0) === 0 && (output ?? 0) === 0;
}

/**
 * Classify a discovered model id. Returns null when the model must not be
 * added automatically (paid or unknown/free-unknown).
 */
export function classifyModel(fullId, { verbose = null, include = [], log = null } = {}) {
  const id = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId;
  const meta = verbose?.get?.(fullId) ?? verbose?.[fullId] ?? null;
  const cost = meta?.cost ?? null;
  const zeroCost = isZeroCost(cost);
  const suffixFree = id.endsWith('-free');
  const knownFree = KNOWN_FREE_IDS.has(id);
  const included = include.length > 0 && matchesAny(id, include);

  if (zeroCost === false) {
    log?.warn?.('rejecting paid model', { model: id, cost });
    return null;
  }

  let reason = null;
  if (zeroCost === true) reason = 'zero-cost';
  else if (suffixFree) reason = 'suffix';
  else if (knownFree) reason = 'known-free';
  else if (included) reason = 'admin-include';

  if (!reason) {
    log?.debug?.('skipping non-free model', { model: id, hasCostMetadata: cost != null });
    return null;
  }

  const limit = meta?.limit ?? null;
  return {
    id,
    fullId,
    context: typeof limit?.context === 'number' ? limit.context : null,
    output: typeof limit?.output === 'number' ? limit.output : null,
    name: meta?.name ?? null,
    status: 'discovered',
    free: true,
    freeReason: reason,
  };
}

/**
 * Run discovery. `run` is injectable for tests:
 *   run({ args, timeoutMs, env, cwd }) -> { ok, kind?, code?, stdout, stderr }
 */
export async function discoverModels({
  bin = 'opencode',
  provider = 'opencode',
  timeoutMs = 30_000,
  env = process.env,
  cwd = undefined,
  exclude = [],
  include = [],
  metadata = {},
  runner = defaultRunner,
  logger = null,
  now = () => new Date(),
} = {}) {
  const started = Date.now();
  const result = {
    ok: false,
    models: [],
    discoveredIds: [],
    excluded: [],
    rejected: [],
    malformed: 0,
    verboseUsed: false,
    durationMs: 0,
    at: now().toISOString(),
    error: null,
  };

  const plain = await runner({ bin, args: ['models', provider], timeoutMs, env, cwd });
  if (!plain.ok) {
    const KNOWN = new Set(['timeout', 'spawn', 'network', 'auth', 'busy', 'unsupported', 'malformed']);
    const kind = KNOWN.has(plain.kind) ? plain.kind : 'exit';
    const fallback = kind === 'timeout'
      ? `'${bin} models ${provider}' timed out after ${timeoutMs}ms`
      : kind === 'spawn'
        ? `'${bin}' could not be executed (not found or not executable)`
        : kind === 'network'
          ? 'model discovery endpoint is unreachable'
          : kind === 'auth'
            ? 'model discovery endpoint rejected the request (authentication)'
            : kind === 'busy'
              ? 'model discovery endpoint is busy; retry later'
              : `'${bin} models ${provider}' exited with code ${plain.code}`;
    const message = plain.message || fallback;
    result.error = { kind, message, stderr: String(plain.stderr ?? '').slice(0, 500) };
    result.durationMs = Date.now() - started;
    logger?.warn?.('model discovery failed', { kind, error: message });
    return result;
  }

  const { ids: discoveredIds, malformed } = parseModelListOutput(plain.stdout);
  result.malformed = malformed;
  result.discoveredIds = discoveredIds.map((f) => f.slice(f.indexOf('/') + 1));

  if (discoveredIds.length === 0) {
    result.error = {
      kind: 'empty',
      message: `'${bin} models ${provider}' returned no models — keeping the previous registry`,
    };
    result.durationMs = Date.now() - started;
    logger?.warn?.('model discovery returned no models; previous registry preserved');
    return result;
  }
  if (discoveredIds.length === 0 && malformed > 0) {
    result.error = { kind: 'malformed', message: 'CLI output could not be parsed' };
    result.durationMs = Date.now() - started;
    return result;
  }

  // Optional metadata enrichment. Never fatal.
  let verbose = null;
  const verboseRun = await runner({ bin, args: ['models', provider, '--verbose'], timeoutMs, env, cwd });
  if (verboseRun.ok && verboseRun.stdout.trim()) {
    try {
      verbose = parseVerboseOutput(verboseRun.stdout);
      result.verboseUsed = verbose.size > 0;
    } catch {
      verbose = null;
    }
  }
  if (!verbose) logger?.debug?.('verbose model metadata unavailable; relying on id conventions');

  const excludePatterns = parsePatterns(exclude);
  const includePatterns = parsePatterns(include);
  const models = [];

  for (const fullId of discoveredIds) {
    const classified = classifyModel(fullId, { verbose, include: includePatterns, log: logger });
    if (!classified) {
      result.rejected.push(fullId.slice(fullId.indexOf('/') + 1));
      continue;
    }
    if (excludePatterns.length && matchesAny(classified.id, excludePatterns)) {
      const pattern = excludePatterns.find((p) => matchPattern(classified.id, p));
      result.excluded.push({ id: classified.id, pattern });
      logger?.debug?.('model excluded', { model: classified.id, pattern });
      continue;
    }
    const override = metadata[classified.id] ?? null;
    if (override) {
      if (typeof override.context === 'number') classified.context = override.context;
      if (typeof override.output === 'number') classified.output = override.output;
    }
    models.push(classified);
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  result.ok = true;
  result.models = models;
  result.durationMs = Date.now() - started;
  logger?.info?.('discovery complete', {
    found: discoveredIds.length,
    free: models.length,
    excluded: result.excluded.length,
    rejected: result.rejected.length,
    malformed,
    verbose: result.verboseUsed,
    ms: result.durationMs,
  });
  return result;
}
