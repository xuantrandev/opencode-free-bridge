// Background model synchronization: discover -> diff -> verify -> deploy ->
// health check -> rollback on failure.

import path from 'node:path';
import { discoverModels } from './discovery.mjs';
import { acquireFileLock, atomicWriteJson, ensureDir, readJsonSafe } from './fsutil.mjs';
import { diffIds, modelIdsOf, validateCandidateModels } from './registry.mjs';
import { mapUpstreamError } from './upstream.mjs';
import { createUpstreamTest, verifyModels } from './verify.mjs';

const MAX_DEPLOYMENTS_KEPT = 50;

export function mergeCandidateModels(currentModels, discoveredModels, { now = () => new Date() } = {}) {
  const stamp = now().toISOString();
  const currentById = new Map(currentModels.map((m) => [m.id, m]));
  const candidate = [];
  for (const d of discoveredModels) {
    const existing = currentById.get(d.id);
    if (existing) {
      candidate.push({
        ...existing,
        context: d.context ?? existing.context ?? null,
        output: d.output ?? existing.output ?? null,
        name: d.name ?? existing.name ?? null,
        freeReason: d.freeReason ?? existing.freeReason ?? null,
      });
    } else {
      candidate.push({
        id: d.id,
        context: d.context ?? null,
        output: d.output ?? null,
        name: d.name ?? null,
        status: 'discovered',
        addedAt: stamp,
        verifiedAt: null,
        failCount: 0,
        freeReason: d.freeReason ?? null,
      });
    }
  }
  candidate.sort((a, b) => a.id.localeCompare(b.id));
  return candidate;
}

export async function fetchJsonWithTimeout(url, { timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: '', error: err };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a deployment through the running bridge.
 * - network failure (bridge down) => { ok: true, skipped: true }
 * - wrong list / unhealthy after the timeout => { ok: false }
 */
export async function httpVerifyDeployment({
  baseUrl,
  expectedIds,
  timeoutMs = 10_000,
  pollIntervalMs = 250,
  fetchImpl = globalThis.fetch,
  logger = null,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  let everReachable = false;
  while (Date.now() < deadline) {
    const res = await fetchJsonWithTimeout(`${baseUrl}/v1/models`, { timeoutMs: Math.min(3000, Math.max(deadline - Date.now(), 1)), fetchImpl });
    if (res.status === 0) {
      return { ok: true, skipped: true, reason: 'bridge-not-running' };
    }
    everReachable = true;
    if (res.ok && Array.isArray(res.json?.data)) {
      const actual = res.json.data.map((m) => m.id).sort();
      const expected = [...expectedIds].sort();
      if (actual.join('\u0000') === expected.join('\u0000')) {
        const health = await fetchJsonWithTimeout(`${baseUrl}/health`, { timeoutMs: 3000, fetchImpl });
        if (health.ok && health.json?.status === 'ok') {
          return { ok: true, verified: true };
        }
        lastError = health.ok ? `health status '${health.json?.status}'` : `health HTTP ${health.status || 'n/a'}`;
      } else {
        lastError = `model list mismatch (actual=${actual.join(',')} expected=${expected.join(',')})`;
      }
    } else {
      lastError = `HTTP ${res.status || 'n/a'} from /v1/models`;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  logger?.error?.('deployment verification failed', { error: lastError, everReachable });
  return { ok: false, error: lastError, everReachable };
}

export class ModelSyncService {
  constructor({
    config,
    registry,
    client = null,
    logger = null,
    runner = undefined,
    testModel = null,
    verifyDeployment = null,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    selfUrl = null,
  } = {}) {
    this.config = config;
    this.registry = registry;
    this.client = client;
    this.logger = logger;
    this.runner = runner;
    this.testModel = testModel;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.selfUrl = selfUrl || `http://127.0.0.1:${config.port}`;
    this._verifyDeployment = verifyDeployment;
    this._running = false;
    this._stopped = false;
    this._timer = null;
    this.lastResult = null;
    this.nextRunAt = null;
    this.runCount = 0;
  }

  get running() {
    return this._running;
  }

  get enabled() {
    return !!this.config.autoSync;
  }

  get intervalMinutes() {
    return this.config.syncIntervalMinutes;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: this._running,
      intervalMinutes: this.intervalMinutes,
      runs: this.runCount,
      lastResult: this.lastResult,
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      lastSync: this.registry.registry.lastSync,
      lastSyncStatus: this.registry.registry.lastSyncStatus,
      lastSyncError: this.registry.registry.lastSyncError ?? null,
    };
  }

  start() {
    if (this._stopped) return;
    if (this.config.syncOnStartup) {
      this.logger?.info?.('model sync: startup sync requested');
      this.runOnce({ trigger: 'startup' }).catch((err) => {
        this.logger?.error?.('startup sync failed', { error: err?.message });
      });
    } else if (this.enabled) {
      this._schedule();
    }
    if (!this.enabled && !this.config.syncOnStartup) {
      this.logger?.info?.('model auto-sync disabled (MODEL_AUTO_SYNC=false)');
    }
  }

  _schedule() {
    if (this._stopped || !this.enabled) return;
    const ms = this.intervalMinutes * 60_000;
    this.nextRunAt = Date.now() + ms;
    this._timer = setTimeout(async () => {
      this._timer = null;
      try {
        await this.runOnce({ trigger: 'interval' });
      } catch (err) {
        this.logger?.error?.('interval sync failed', { error: err?.message });
      }
      this._schedule();
    }, ms);
    this._timer.unref?.();
    this.logger?.debug?.('model sync scheduled', { nextRunAt: new Date(this.nextRunAt).toISOString(), intervalMinutes: this.intervalMinutes });
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.nextRunAt = null;
  }

  // ------------------------------------------------------------------ sync

  async runOnce({ trigger = 'manual' } = {}) {
    if (this._running) {
      this.logger?.warn?.('model sync skipped: another sync is already running');
      return { status: 'skipped', reason: 'in-progress', trigger, at: this.now().toISOString() };
    }
    this._running = true;
    const started = Date.now();
    const lock = acquireFileLock(this.config.paths.syncLockFile, { staleMs: this.config.syncLockStaleMs });
    if (!lock.acquired) {
      this._running = false;
      this.logger?.warn?.('model sync skipped: lock held by another process');
      return { status: 'skipped', reason: 'locked', trigger, at: this.now().toISOString() };
    }
    try {
      const result = await this._sync(trigger, started);
      this.lastResult = result;
      this.runCount += 1;
      return result;
    } catch (err) {
      this.logger?.error?.('model sync crashed', { error: err?.message, stack: err?.stack });
      const result = { status: 'failed', trigger, at: this.now().toISOString(), error: err?.message || String(err), durationMs: Date.now() - started, added: [], removed: [] };
      this.lastResult = result;
      this.runCount += 1;
      return result;
    } finally {
      lock.release();
      this._running = false;
      if (!this._stopped) this._schedule();
    }
  }

  async _sync(trigger, started) {
    const { registry, config, logger } = this;
    const exclude = [...registry.excludePatterns, ...config.excludePatterns];
    const discovery = await discoverModels({
      bin: config.opencodeBin,
      provider: config.provider,
      timeoutMs: config.discoveryTimeoutMs,
      exclude,
      include: registry.exclusions.include,
      metadata: registry.metadata,
      runner: this.runner,
      logger,
    });

    const at = this.now().toISOString();

    if (!discovery.ok) {
      await registry.recordSync({ status: 'failed', trigger, error: discovery.error?.message, at });
      logger?.warn?.('model sync failed; keeping previous registry', { trigger, error: discovery.error?.message });
      return {
        status: 'failed',
        trigger,
        at,
        durationMs: Date.now() - started,
        error: discovery.error,
        added: [],
        removed: [],
        excluded: discovery.excluded,
        rejected: discovery.rejected,
        kept: registry.models.length,
      };
    }

    const currentModels = registry.models;
    const candidate = mergeCandidateModels(currentModels, discovery.models);
    const diff = diffIds(modelIdsOf(currentModels), modelIdsOf(candidate));

    if (diff.added.length === 0 && diff.removed.length === 0) {
      await registry.recordSync({ status: 'unchanged', trigger, at });
      logger?.info?.('model sync: no changes', { trigger, models: candidate.length, ms: Date.now() - started });
      return {
        status: 'unchanged',
        trigger,
        at,
        durationMs: Date.now() - started,
        added: [],
        removed: [],
        kept: candidate.length,
        excluded: discovery.excluded,
        rejected: discovery.rejected,
      };
    }

    logger?.info?.('model registry changes detected', {
      trigger,
      added: diff.added,
      removed: diff.removed,
      total: candidate.length,
    });

    if (!config.autoDeploy) {
      await registry.recordSync({ status: 'pending', trigger, at });
      logger?.warn?.('MODEL_AUTO_DEPLOY=false: changes detected but not deployed', { added: diff.added, removed: diff.removed });
      return {
        status: 'pending',
        trigger,
        at,
        durationMs: Date.now() - started,
        added: diff.added,
        removed: diff.removed,
        kept: diff.kept.length,
        excluded: discovery.excluded,
        rejected: discovery.rejected,
        deployed: false,
      };
    }

    const validation = validateCandidateModels(candidate, { previous: modelIdsOf(currentModels) });
    if (!validation.ok) {
      await registry.recordSync({ status: 'failed', trigger, error: validation.errors.join('; '), at });
      logger?.error?.('candidate registry rejected by validation', { errors: validation.errors });
      return {
        status: 'failed',
        trigger,
        at,
        durationMs: Date.now() - started,
        error: { kind: 'validation', message: validation.errors.join('; ') },
        added: diff.added,
        removed: diff.removed,
        kept: diff.kept.length,
      };
    }

    let verification = null;
    let verifiedCandidate = candidate;
    if (config.validateInference && diff.added.length > 0) {
      verifiedCandidate = await this._verifyNewModels(candidate, diff.added);
      verification = this._verificationSummary;
    }

    registry.capturePrevious();
    const { backup } = await registry.deploy(verifiedCandidate, { reason: trigger });

    let deployCheck = { ok: true, skipped: true };
    if (config.healthCheck) {
      deployCheck = await this._verifyDeploymentImpl({
        expectedIds: modelIdsOf(verifiedCandidate),
        baseUrl: this.selfUrl,
      });
    }

    if (!deployCheck.ok) {
      const restored = await registry.rollback('deployment-verification-failed');
      await registry.recordSync({ status: 'rolled-back', trigger, error: deployCheck.error, at });
      await this._recordDeployment({
        at, trigger, status: 'rolled-back', added: diff.added, removed: diff.removed,
        backup, error: deployCheck.error, models: modelIdsOf(restored?.models ?? currentModels),
      });
      logger?.error?.('deployment verification failed; rolled back', { error: deployCheck.error });
      return {
        status: 'rolled-back',
        trigger,
        at,
        durationMs: Date.now() - started,
        added: diff.added,
        removed: diff.removed,
        kept: diff.kept.length,
        error: { kind: 'verification', message: deployCheck.error },
        backup,
        verification,
      };
    }

    await registry.recordSync({ status: 'deployed', trigger, at });
    await this._recordDeployment({
      at, trigger, status: 'deployed', added: diff.added, removed: diff.removed,
      backup, verified: deployCheck.verified === true, skipped: deployCheck.skipped === true,
      models: modelIdsOf(verifiedCandidate),
    });
    logger?.info?.('model sync deployed', {
      trigger,
      added: diff.added,
      removed: diff.removed,
      total: verifiedCandidate.length,
      ms: Date.now() - started,
      verified: deployCheck.verified === true,
    });

    return {
      status: 'deployed',
      trigger,
      at,
      durationMs: Date.now() - started,
      added: diff.added,
      removed: diff.removed,
      kept: diff.kept.length,
      excluded: discovery.excluded,
      rejected: discovery.rejected,
      backup,
      verification,
      deployVerified: deployCheck.verified === true,
      deployVerificationSkipped: deployCheck.skipped === true,
    };
  }

  async _verifyNewModels(candidate, addedIds) {
    const addedSet = new Set(addedIds);
    const modelsToTest = candidate.filter((m) => addedSet.has(m.id));
    if (!this.testModel && !this.client) {
      this.logger?.warn?.('inference verification requested but no client available; marking models as discovered');
      return candidate;
    }
    const test = this.testModel ?? createUpstreamTest({ client: this.client });
    const { results, globalFailure } = await verifyModels({
      models: modelsToTest,
      test,
      stateFile: this.config.paths.verificationFile,
      timeoutMs: this.config.verifyTimeoutMs,
      concurrency: this.config.verifyConcurrency,
      maxPerRun: this.config.verifyMaxPerRun,
      retryHours: this.config.verifyRetryHours,
      logger: this.logger,
      now: () => this.now().getTime(),
    });
    this._verificationSummary = {
      attempted: results.length,
      verified: results.filter((r) => r.status === 'verified').length,
      failed: results.filter((r) => r.status === 'failed').length,
      globalFailure,
    };
    if (globalFailure) {
      this.logger?.warn?.('global verification failure; models remain marked as discovered');
      return candidate;
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    return candidate.map((m) => {
      const r = byId.get(m.id);
      if (!r) return m;
      return {
        ...m,
        status: r.status === 'verified' ? 'verified' : 'verification-failed',
        verifiedAt: r.status === 'verified' ? r.checkedAt : m.verifiedAt ?? null,
        failCount: r.failCount,
      };
    });
  }

  _verifyDeploymentImpl(args) {
    if (this._verifyDeployment) return this._verifyDeployment(args);
    return httpVerifyDeployment({ ...args, timeoutMs: this.config.deployVerifyTimeoutMs, fetchImpl: this.fetchImpl, logger: this.logger });
  }

  async _recordDeployment(entry) {
    const file = this.config.paths.deploymentsFile;
    try {
      ensureDir(path.dirname(file));
      const { value } = readJsonSafe(file);
      const deployments = Array.isArray(value?.deployments) ? value.deployments : [];
      deployments.push(entry);
      await atomicWriteJson(file, { deployments: deployments.slice(-MAX_DEPLOYMENTS_KEPT) });
    } catch (err) {
      this.logger?.warn?.('could not record deployment', { error: err?.message });
    }
  }
}

export { mapUpstreamError };
