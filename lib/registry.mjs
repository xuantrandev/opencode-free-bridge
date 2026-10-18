// Persistent model registry (config/models.json) + exclusions/metadata files.
//
// Design goals:
//  - validation on load, legible JSON on disk
//  - atomic writes (tmp + rename), timestamped backups before every deploy
//  - graceful fallback: models.json -> models.json.bak -> models.default.json
//  - hot reload (fs.watch + mtime polling) so the bridge never needs a restart
//    just because the model list changed
//  - a single in-memory snapshot swapped atomically, so in-flight requests are
//    never interrupted

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  atomicWriteJson, ensureDir, fileExists, pruneOldFiles, readFileStat, readJsonSafe, sha256Short,
} from './fsutil.mjs';
import { parsePatterns } from './config.mjs';

export const REGISTRY_VERSION = 1;
const ID_RX = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isValidModelId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && ID_RX.test(id);
}

export function normalizeModelEntry(entry) {
  if (typeof entry === 'string') {
    return isValidModelId(entry)
      ? { id: entry, context: null, output: null, status: 'discovered', addedAt: null, verifiedAt: null, failCount: 0, freeReason: null }
      : null;
  }
  if (!entry || typeof entry !== 'object' || !isValidModelId(entry.id)) return null;
  return {
    id: entry.id,
    context: Number.isFinite(entry.context) ? entry.context : null,
    output: Number.isFinite(entry.output) ? entry.output : null,
    status: ['discovered', 'verified', 'verification-failed'].includes(entry.status) ? entry.status : 'discovered',
    addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
    verifiedAt: typeof entry.verifiedAt === 'string' ? entry.verifiedAt : null,
    failCount: Number.isFinite(entry.failCount) ? entry.failCount : 0,
    freeReason: typeof entry.freeReason === 'string' ? entry.freeReason : null,
    name: typeof entry.name === 'string' ? entry.name : null,
  };
}

/** Validate + normalize a raw registry object. Returns { registry, errors, valid }. */
export function normalizeRegistry(raw, { logger = null } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ['registry is not an object'],
      registry: emptyRegistry(),
    };
  }
  if (!Array.isArray(raw.models)) {
    return {
      valid: false,
      errors: ['registry.models is not an array'],
      registry: emptyRegistry(),
    };
  }
  const models = [];
  const seen = new Set();
  for (const entry of raw.models) {
    const normalized = normalizeModelEntry(entry);
    if (!normalized) {
      errors.push(`invalid model entry: ${JSON.stringify(entry).slice(0, 80)}`);
      continue;
    }
    if (seen.has(normalized.id)) {
      errors.push(`duplicate model entry: ${normalized.id}`);
      continue;
    }
    seen.add(normalized.id);
    models.push(normalized);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  if (errors.length && logger) logger.warn?.('registry validation warnings', { errors: errors.slice(0, 5), count: errors.length });
  return {
    valid: true,
    errors,
    registry: {
      version: REGISTRY_VERSION,
      models,
      lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : null,
      lastSync: typeof raw.lastSync === 'string' ? raw.lastSync : null,
      lastSyncStatus: typeof raw.lastSyncStatus === 'string' ? raw.lastSyncStatus : null,
      lastDeploy: raw.lastDeploy && typeof raw.lastDeploy === 'object' ? raw.lastDeploy : null,
      source: typeof raw.source === 'string' ? raw.source : 'opencode models opencode',
      generation: Number.isFinite(raw.generation) ? raw.generation : 0,
    },
  };
}

export function emptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    models: [],
    lastUpdated: null,
    lastSync: null,
    lastSyncStatus: null,
    lastDeploy: null,
    source: 'opencode models opencode',
    generation: 0,
  };
}

export function modelIdsOf(models) {
  return models.map((m) => (typeof m === 'string' ? m : m.id));
}

export function diffIds(previousIds, nextIds) {
  const prev = new Set(previousIds);
  const next = new Set(nextIds);
  const added = [...next].filter((id) => !prev.has(id));
  const removed = [...prev].filter((id) => !next.has(id));
  const kept = [...next].filter((id) => prev.has(id));
  return { added, removed, kept };
}

export function registryHash(models) {
  const ids = modelIdsOf(models).slice().sort();
  return sha256Short(JSON.stringify(ids));
}

export function validateCandidateModels(models, { previous = [] } = {}) {
  const errors = [];
  if (!Array.isArray(models)) return { ok: false, errors: ['candidate is not an array'] };
  const seen = new Set();
  for (const m of models) {
    const id = typeof m === 'string' ? m : m?.id;
    if (!isValidModelId(id)) errors.push(`invalid model id: ${JSON.stringify(m).slice(0, 80)}`);
    else if (seen.has(id)) errors.push(`duplicate model id: ${id}`);
    else seen.add(id);
  }
  if (models.length === 0 && previous.length > 0) {
    errors.push('refusing to deploy an empty model list over a non-empty registry');
  }
  return { ok: errors.length === 0, errors };
}

export class ModelRegistry extends EventEmitter {
  constructor({ paths, logger = null, now = () => new Date() } = {}) {
    super();
    this.paths = paths;
    this.logger = logger;
    this.now = now;
    this.registry = emptyRegistry();
    this.loadedFrom = null;
    this.exclusions = { exclude: [], include: [], reasons: {} };
    this.metadata = {};
    this._fileStat = { exists: false, mtimeMs: 0, size: 0 };
    this._writeChain = Promise.resolve();
    this._watcher = null;
    this._watchTimer = null;
    this._closed = false;
    this.previousSnapshot = null;
  }

  // ---------------------------------------------------------------- loading

  load() {
    const result = this.reloadFromDisk({ force: true, initial: true });
    this.exclusions = this.loadExclusions();
    this.metadata = this.loadMetadata();
    return result;
  }

  loadExclusions() {
    const fallback = { exclude: [], include: [], reasons: {} };
    const { ok, value } = readJsonSafe(this.paths.exclusionsFile);
    if (!ok || !value || typeof value !== 'object') return fallback;
    return {
      exclude: Array.isArray(value.exclude) ? value.exclude.filter((p) => typeof p === 'string' && p.trim()) : [],
      include: Array.isArray(value.include) ? value.include.filter((p) => typeof p === 'string' && p.trim()) : [],
      reasons: value.reasons && typeof value.reasons === 'object' ? value.reasons : {},
    };
  }

  loadMetadata() {
    const { ok, value } = readJsonSafe(this.paths.metadataFile);
    if (!ok || !value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [id, meta] of Object.entries(value)) {
      if (!isValidModelId(id) || !meta || typeof meta !== 'object') continue;
      out[id] = {};
      if (Number.isFinite(meta.context)) out[id].context = meta.context;
      if (Number.isFinite(meta.output)) out[id].output = meta.output;
    }
    return out;
  }

  /**
   * Re-read config/models.json when it changed on disk (or force). Falls back
   * to models.json.bak and models.default.json when the primary file is
   * missing or malformed, and keeps the in-memory registry when everything
   * fails — the bridge must never crash because a file is temporarily
   * unavailable.
   */
  reloadFromDisk({ force = false, initial = false } = {}) {
    const primary = this.paths.modelsFile;
    const stat = readFileStat(primary);
    if (!force && !initial && stat.exists === this._fileStat.exists
      && stat.mtimeMs === this._fileStat.mtimeMs && stat.size === this._fileStat.size) {
      return { changed: false, registry: this.registry, source: this.loadedFrom };
    }

    const candidates = [primary, `${primary}.bak`, this.paths.modelsDefaultFile];
    let chosen = null;
    const errors = [];
    for (const file of candidates) {
      if (!fileExists(file)) continue;
      const { ok, value, error } = readJsonSafe(file);
      if (!ok) {
        errors.push(`${path.basename(file)}: ${error?.message || 'unreadable'}`);
        continue;
      }
      const { valid, registry, errors: verrs } = normalizeRegistry(value, { logger: this.logger });
      if (!valid) {
        errors.push(`${path.basename(file)}: ${verrs[0] || 'invalid'}`);
        continue;
      }
      chosen = { file, registry };
      if (verrs.length) errors.push(...verrs);
      break;
    }

    if (!chosen) {
      if (initial || this.registry.models.length === 0) {
        this._fileStat = stat;
        this.loadedFrom = null;
        if (errors.length) {
          this.logger?.error?.('no usable model registry found; starting with an empty registry', { errors: errors.slice(0, 3) });
        }
        return { changed: false, registry: this.registry, source: null, errors };
      }
      this.logger?.warn?.('registry reload failed; keeping in-memory registry', { errors: errors.slice(0, 3) });
      return { changed: false, registry: this.registry, source: this.loadedFrom, errors };
    }

    const previousIds = modelIdsOf(this.registry.models);
    const previousHash = registryHash(this.registry.models);
    const nextHash = registryHash(chosen.registry.models);
    const changed = previousHash !== nextHash || this.loadedFrom !== chosen.file;
    const nextIds = modelIdsOf(chosen.registry.models);
    this.registry = chosen.registry;
    this.loadedFrom = chosen.file;
    this._fileStat = readFileStat(primary);
    if (changed && !initial) {
      const diff = diffIds(previousIds, nextIds);
      this.emit('change', { source: 'reload', file: chosen.file, ...diff });
      this.logger?.info?.('registry reloaded from disk', { file: path.basename(chosen.file), models: chosen.registry.models.length, ...diff });
    }
    return { changed, registry: this.registry, source: chosen.file, errors };
  }

  // ---------------------------------------------------------------- accessors

  get models() {
    return this.registry.models;
  }

  get ids() {
    return new Set(this.registry.models.map((m) => m.id));
  }

  has(id) {
    return this.registry.models.some((m) => m.id === id);
  }

  get(id) {
    return this.registry.models.find((m) => m.id === id) ?? null;
  }

  snapshot() {
    return {
      ...this.registry,
      models: this.registry.models.map((m) => ({ ...m })),
      hash: registryHash(this.registry.models),
      generation: this.registry.generation,
    };
  }

  // ---------------------------------------------------------------- writing

  serialize(fn) {
    const next = this._writeChain.then(fn, fn);
    this._writeChain = next.catch(() => {});
    return next;
  }

  buildRegistryFile(registry) {
    return {
      version: REGISTRY_VERSION,
      models: registry.models,
      lastUpdated: registry.lastUpdated,
      lastSync: registry.lastSync,
      lastSyncStatus: registry.lastSyncStatus,
      lastDeploy: registry.lastDeploy,
      source: registry.source,
      generation: registry.generation,
    };
  }

  async backupCurrent(reason = 'deploy') {
    const file = this.paths.modelsFile;
    if (!fileExists(file)) return null;
    ensureDir(this.paths.backupsDir);
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(this.paths.backupsDir, `models-${stamp}-${reason}.json`);
    fs.copyFileSync(file, backup);
    fs.copyFileSync(file, `${file}.bak`);
    pruneOldFiles(this.paths.backupsDir, { pattern: /^models-.*\.json$/, keep: 20 });
    return backup;
  }

  /**
   * Atomically activate a new model list. Returns { backup, snapshot }.
   * Honors the write queue so concurrent deploys cannot interleave.
   */
  async deploy(candidateModels, { reason = 'sync', makeBackup = true } = {}) {
    return this.serialize(async () => {
      const nowIso = this.now().toISOString();
      const backup = makeBackup ? await this.backupCurrent(reason) : null;
      const previousIds = modelIdsOf(this.registry.models);
      const nextIds = modelIdsOf(candidateModels);
      const registry = {
        ...this.registry,
        models: candidateModels.map((m) => ({ ...m })),
        lastUpdated: nowIso,
        generation: (this.registry.generation || 0) + 1,
      };
      registry.models.sort((a, b) => a.id.localeCompare(b.id));
      await atomicWriteJson(this.paths.modelsFile, this.buildRegistryFile(registry));
      this.previousSnapshot = this.snapshot();
      this.registry = registry;
      this._fileStat = readFileStat(this.paths.modelsFile);
      this.loadedFrom = this.paths.modelsFile;
      const diff = diffIds(previousIds, nextIds);
      this.emit('change', { source: 'deploy', reason, ...diff });
      this.logger?.info?.('registry deployed', { reason, generation: registry.generation, added: diff.added, removed: diff.removed, models: nextIds.length, backup: backup ? path.basename(backup) : null });
      return { backup, snapshot: this.snapshot(), diff };
    });
  }

  /** Restore the last-known-good snapshot (used when deployment verification fails). */
  async rollback(reason = 'verification-failed') {
    return this.serialize(async () => {
      if (!this.previousSnapshot) {
        this.logger?.warn?.('rollback requested but no previous snapshot is available');
        return null;
      }
      const target = {
        ...this.previousSnapshot,
        lastUpdated: this.now().toISOString(),
        lastDeploy: { at: this.now().toISOString(), status: 'rolled-back', reason },
        generation: (this.registry.generation || 0) + 1,
      };
      delete target.hash;
      await atomicWriteJson(this.paths.modelsFile, this.buildRegistryFile(target));
      const previousIds = modelIdsOf(this.registry.models);
      this.registry = target;
      this._fileStat = readFileStat(this.paths.modelsFile);
      const diff = diffIds(previousIds, modelIdsOf(target.models));
      this.emit('change', { source: 'rollback', reason, ...diff });
      this.logger?.warn?.('registry rolled back', { reason, models: target.models.length, ...diff });
      return this.snapshot();
    });
  }

  /** Attach a fresh last-known-good snapshot (e.g. before a CLI-side deploy). */
  capturePrevious() {
    this.previousSnapshot = this.snapshot();
    return this.previousSnapshot;
  }

  /** Metadata-only update (verification results, timestamps). No backup, no version bump of ids. */
  async updateMeta(mutate, { eventName = 'meta' } = {}) {
    return this.serialize(async () => {
      const registry = {
        ...this.registry,
        models: this.registry.models.map((m) => ({ ...m })),
      };
      mutate(registry);
      await atomicWriteJson(this.paths.modelsFile, this.buildRegistryFile(registry));
      this.registry = registry;
      this._fileStat = readFileStat(this.paths.modelsFile);
      this.emit(eventName, { models: registry.models });
      return this.snapshot();
    });
  }

  async recordSync({ status, trigger = 'manual', added = [], removed = [], error = null, at = null }) {
    const stamp = at || this.now().toISOString();
    return this.serialize(async () => {
      this.registry = { ...this.registry, lastSync: stamp, lastSyncStatus: status };
      if (status === 'failed' && error) {
        this.registry.lastSyncError = String(error).slice(0, 300);
      } else if (status !== 'failed') {
        delete this.registry.lastSyncError;
      }
      try {
        await atomicWriteJson(this.paths.modelsFile, this.buildRegistryFile(this.registry));
        this._fileStat = readFileStat(this.paths.modelsFile);
      } catch (err) {
        this.logger?.warn?.('could not persist sync status', { error: err?.message });
      }
      return { status, trigger, added, removed, at: stamp };
    });
  }

  // ------------------------------------------------------- exclusions file

  async saveExclusions(next) {
    const value = {
      exclude: [...new Set(next.exclude)].sort(),
      include: [...new Set(next.include)].sort(),
      reasons: next.reasons,
    };
    await atomicWriteJson(this.paths.exclusionsFile, value);
    this.exclusions = value;
    this.emit('exclusions', value);
    return value;
  }

  async setExclusion(pattern, reason = null) {
    const next = {
      exclude: [...this.exclusions.exclude, pattern],
      include: this.exclusions.include,
      reasons: { ...this.exclusions.reasons },
    };
    if (reason) next.reasons[pattern] = reason;
    return this.saveExclusions(next);
  }

  async removeExclusion(pattern) {
    const next = {
      exclude: this.exclusions.exclude.filter((p) => p !== pattern),
      include: this.exclusions.include,
      reasons: { ...this.exclusions.reasons },
    };
    delete next.reasons[pattern];
    return this.saveExclusions(next);
  }

  async setInclude(pattern) {
    const next = {
      exclude: this.exclusions.exclude.filter((p) => p !== pattern),
      include: [...this.exclusions.include, pattern],
      reasons: { ...this.exclusions.reasons },
    };
    delete next.reasons[pattern];
    return this.saveExclusions(next);
  }

  async removeInclude(pattern) {
    const next = {
      exclude: this.exclusions.exclude,
      include: this.exclusions.include.filter((p) => p !== pattern),
      reasons: { ...this.exclusions.reasons },
    };
    return this.saveExclusions(next);
  }

  get excludePatterns() {
    return parsePatterns(this.exclusions.exclude);
  }

  // ------------------------------------------------------------- watching

  watch({ debounceMs = 150 } = {}) {
    if (this._watcher || this._closed) return;
    const dir = path.dirname(this.paths.modelsFile);
    try {
      ensureDir(dir);
      this._watcher = fs.watch(dir, { persistent: false }, () => {
        clearTimeout(this._watchTimer);
        this._watchTimer = setTimeout(() => {
          this.reloadFromDisk({ force: true });
          const nextExclusions = this.loadExclusions();
          if (JSON.stringify(nextExclusions) !== JSON.stringify(this.exclusions)) {
            this.exclusions = nextExclusions;
            this.emit('exclusions', nextExclusions);
          }
          const nextMetadata = this.loadMetadata();
          if (JSON.stringify(nextMetadata) !== JSON.stringify(this.metadata)) {
            this.metadata = nextMetadata;
            this.emit('metadata', nextMetadata);
          }
        }, debounceMs);
        this._watchTimer.unref?.();
      });
      this._watcher.on('error', () => {
        this._watcher = null; // polling fallback still applies
      });
    } catch (err) {
      this.logger?.warn?.('fs.watch unavailable; falling back to polling', { error: err?.message });
      this._watcher = null;
    }
  }

  close() {
    this._closed = true;
    clearTimeout(this._watchTimer);
    try {
      this._watcher?.close();
    } catch { /* non-fatal */ }
    this._watcher = null;
  }
}
