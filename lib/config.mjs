// Configuration loading for opencode-free-bridge.
// Zero dependencies: parses .env manually, never overrides real environment
// variables, validates numeric values, and keeps everything loopback-only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  PORT: 5577,
  HOST: '127.0.0.1',
  OPENCODE_UPSTREAM: 'http://127.0.0.1:4577',
  OPENCODE_BIN: 'opencode',
  OPENCODE_PROVIDER: 'opencode',
  OPENCODE_AGENT: 'general',
  MODEL_AUTO_SYNC: true,
  MODEL_SYNC_INTERVAL_MINUTES: 60,
  MODEL_SYNC_ON_STARTUP: true,
  MODEL_AUTO_DEPLOY: true,
  MODEL_HEALTH_CHECK: true,
  MODEL_EXCLUDE: '',
  MODEL_VALIDATE_INFERENCE: false,
  MODEL_DISCOVERY_TIMEOUT_MS: 60000,
  MODEL_VERIFY_TIMEOUT_MS: 60000,
  MODEL_VERIFY_CONCURRENCY: 1,
  MODEL_VERIFY_MAX_PER_RUN: 3,
  MODEL_VERIFY_RETRY_HOURS: 12,
  UPSTREAM_TIMEOUT_MS: 300000,
  UPSTREAM_CONNECT_TIMEOUT_MS: 10000,
  UPSTREAM_RETRIES: 2,
  UPSTREAM_RETRY_BASE_MS: 500,
  HEALTH_UPSTREAM_TIMEOUT_MS: 2000,
  HEALTH_CACHE_MS: 10000,
  LOG_LEVEL: 'info',
  LOG_FILE: '',
  DEPLOY_VERIFY_TIMEOUT_MS: 10000,
  DEPLOY_VERIFY_STABLE_MS: 20000,
  SYNC_LOCK_STALE_MS: 600000,
  SESSION_MODE: 'per-request',
  INCLUDE_HISTORY: true,
  BACKUP_KEEP: 20,
};

const BOOL_KEYS = new Set([
  'MODEL_AUTO_SYNC', 'MODEL_SYNC_ON_STARTUP', 'MODEL_AUTO_DEPLOY',
  'MODEL_HEALTH_CHECK', 'MODEL_VALIDATE_INFERENCE', 'INCLUDE_HISTORY',
]);
const NUM_KEYS = new Set([
  'PORT', 'MODEL_SYNC_INTERVAL_MINUTES', 'MODEL_DISCOVERY_TIMEOUT_MS',
  'MODEL_VERIFY_TIMEOUT_MS', 'MODEL_VERIFY_CONCURRENCY', 'MODEL_VERIFY_MAX_PER_RUN',
  'MODEL_VERIFY_RETRY_HOURS', 'UPSTREAM_TIMEOUT_MS', 'UPSTREAM_CONNECT_TIMEOUT_MS',
  'UPSTREAM_RETRIES', 'UPSTREAM_RETRY_BASE_MS', 'HEALTH_UPSTREAM_TIMEOUT_MS',
  'HEALTH_CACHE_MS', 'DEPLOY_VERIFY_TIMEOUT_MS', 'DEPLOY_VERIFY_STABLE_MS',
  'SYNC_LOCK_STALE_MS', 'BACKUP_KEEP',
]);

export function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.includes(' #') && !value.startsWith('#')) {
      // tolerate trailing comments on unquoted values
      const maybe = value.slice(0, value.indexOf(' #')).trim();
      if (maybe) value = maybe;
    }
    out[key] = value;
  }
  return out;
}

export function loadDotenv(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(s)) return false;
  return fallback;
}

function envValue(env, dotenv, key) {
  if (env[key] !== undefined && env[key] !== '') return env[key];
  if (dotenv[key] !== undefined) return dotenv[key];
  return undefined;
}

// Comma/whitespace separated glob list. `*` and `?` wildcards are supported;
// a pattern prefixed with `re:` is treated as a regular expression.
export function parsePatterns(value) {
  if (!value) return [];
  return String(value)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function matchPattern(id, pattern) {
  if (pattern.startsWith('re:')) {
    try {
      return new RegExp(pattern.slice(3)).test(id);
    } catch {
      return false;
    }
  }
  const rx = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  return rx.test(id);
}

export function matchesAny(id, patterns) {
  return patterns.some((p) => matchPattern(id, p));
}

/**
 * Build the effective configuration from process env + .env file.
 * `env` overrides are mainly used by tests.
 */
export function loadConfig({ root = null, env = process.env, overrides = {} } = {}) {
  const effectiveRoot = root || env.OPENCODE_FREE_BRIDGE_DIR || ROOT;
  const dotenv = loadDotenv(path.join(effectiveRoot, '.env'));
  const get = (key) => envValue(env, dotenv, key);

  const cfg = {
    root: effectiveRoot,
    host: DEFAULTS.HOST,
    port: DEFAULTS.PORT,
    upstream: DEFAULTS.OPENCODE_UPSTREAM,
    opencodeBin: DEFAULTS.OPENCODE_BIN,
    provider: DEFAULTS.OPENCODE_PROVIDER,
    agent: DEFAULTS.OPENCODE_AGENT,
    autoSync: DEFAULTS.MODEL_AUTO_SYNC,
    syncIntervalMinutes: DEFAULTS.MODEL_SYNC_INTERVAL_MINUTES,
    syncOnStartup: DEFAULTS.MODEL_SYNC_ON_STARTUP,
    autoDeploy: DEFAULTS.MODEL_AUTO_DEPLOY,
    healthCheck: DEFAULTS.MODEL_HEALTH_CHECK,
    excludePatterns: parsePatterns(DEFAULTS.MODEL_EXCLUDE),
    validateInference: DEFAULTS.MODEL_VALIDATE_INFERENCE,
    discoveryTimeoutMs: DEFAULTS.MODEL_DISCOVERY_TIMEOUT_MS,
    verifyTimeoutMs: DEFAULTS.MODEL_VERIFY_TIMEOUT_MS,
    verifyConcurrency: DEFAULTS.MODEL_VERIFY_CONCURRENCY,
    verifyMaxPerRun: DEFAULTS.MODEL_VERIFY_MAX_PER_RUN,
    verifyRetryHours: DEFAULTS.MODEL_VERIFY_RETRY_HOURS,
    upstreamTimeoutMs: DEFAULTS.UPSTREAM_TIMEOUT_MS,
    upstreamConnectTimeoutMs: DEFAULTS.UPSTREAM_CONNECT_TIMEOUT_MS,
    upstreamRetries: DEFAULTS.UPSTREAM_RETRIES,
    upstreamRetryBaseMs: DEFAULTS.UPSTREAM_RETRY_BASE_MS,
    healthUpstreamTimeoutMs: DEFAULTS.HEALTH_UPSTREAM_TIMEOUT_MS,
    healthCacheMs: DEFAULTS.HEALTH_CACHE_MS,
    logLevel: DEFAULTS.LOG_LEVEL,
    logFile: DEFAULTS.LOG_FILE,
    deployVerifyTimeoutMs: DEFAULTS.DEPLOY_VERIFY_TIMEOUT_MS,
    deployVerifyStableMs: DEFAULTS.DEPLOY_VERIFY_STABLE_MS,
    syncLockStaleMs: DEFAULTS.SYNC_LOCK_STALE_MS,
    sessionMode: DEFAULTS.SESSION_MODE,
    includeHistory: DEFAULTS.INCLUDE_HISTORY,
    backupKeep: DEFAULTS.BACKUP_KEEP,
    pathOverrides: {},
  };

  const mapping = {
    PORT: ['port', 'int'],
    OPENCODE_UPSTREAM: ['upstream', 'str'],
    OPENCODE_BIN: ['opencodeBin', 'str'],
    OPENCODE_PROVIDER: ['provider', 'str'],
    OPENCODE_AGENT: ['agent', 'str'],
    MODEL_AUTO_SYNC: ['autoSync', 'bool'],
    MODEL_SYNC_INTERVAL_MINUTES: ['syncIntervalMinutes', 'int'],
    MODEL_SYNC_ON_STARTUP: ['syncOnStartup', 'bool'],
    MODEL_AUTO_DEPLOY: ['autoDeploy', 'bool'],
    MODEL_HEALTH_CHECK: ['healthCheck', 'bool'],
    MODEL_VALIDATE_INFERENCE: ['validateInference', 'bool'],
    MODEL_DISCOVERY_TIMEOUT_MS: ['discoveryTimeoutMs', 'int'],
    MODEL_VERIFY_TIMEOUT_MS: ['verifyTimeoutMs', 'int'],
    MODEL_VERIFY_CONCURRENCY: ['verifyConcurrency', 'int'],
    MODEL_VERIFY_MAX_PER_RUN: ['verifyMaxPerRun', 'int'],
    MODEL_VERIFY_RETRY_HOURS: ['verifyRetryHours', 'num'],
    UPSTREAM_TIMEOUT_MS: ['upstreamTimeoutMs', 'int'],
    UPSTREAM_CONNECT_TIMEOUT_MS: ['upstreamConnectTimeoutMs', 'int'],
    UPSTREAM_RETRIES: ['upstreamRetries', 'int'],
    UPSTREAM_RETRY_BASE_MS: ['upstreamRetryBaseMs', 'int'],
    HEALTH_UPSTREAM_TIMEOUT_MS: ['healthUpstreamTimeoutMs', 'int'],
    HEALTH_CACHE_MS: ['healthCacheMs', 'int'],
    LOG_LEVEL: ['logLevel', 'str'],
    LOG_FILE: ['logFile', 'str'],
    DEPLOY_VERIFY_TIMEOUT_MS: ['deployVerifyTimeoutMs', 'int'],
    DEPLOY_VERIFY_STABLE_MS: ['deployVerifyStableMs', 'int'],
    SYNC_LOCK_STALE_MS: ['syncLockStaleMs', 'int'],
    SESSION_MODE: ['sessionMode', 'str'],
    INCLUDE_HISTORY: ['includeHistory', 'bool'],
    BACKUP_KEEP: ['backupKeep', 'int'],
  };

  const warnings = [];
  for (const [envKey, [prop, kind]] of Object.entries(mapping)) {
    const raw = get(envKey);
    if (raw === undefined) continue;
    if (kind === 'bool') {
      cfg[prop] = parseBool(raw, cfg[prop]);
    } else if (kind === 'int') {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) cfg[prop] = n;
      else warnings.push(`${envKey}: not an integer (${raw})`);
    } else if (kind === 'num') {
      const n = Number(raw);
      if (Number.isFinite(n)) cfg[prop] = n;
      else warnings.push(`${envKey}: not a number (${raw})`);
    } else {
      cfg[prop] = String(raw);
    }
  }

  cfg.excludePatterns = parsePatterns(get('MODEL_EXCLUDE'));
  cfg.warnings = warnings;

  if (!['shared', 'per-request'].includes(cfg.sessionMode)) {
    warnings.push(`SESSION_MODE must be shared|per-request, got '${cfg.sessionMode}' — using per-request`);
    cfg.sessionMode = 'per-request';
  }
  if (!Number.isFinite(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    warnings.push(`PORT invalid (${cfg.port}) — using ${DEFAULTS.PORT}`);
    cfg.port = DEFAULTS.PORT;
  }
  if (cfg.syncIntervalMinutes < 1) cfg.syncIntervalMinutes = 1;
  if (cfg.verifyConcurrency < 1) cfg.verifyConcurrency = 1;
  if (cfg.verifyMaxPerRun < 0) cfg.verifyMaxPerRun = 0;
  if (cfg.upstreamRetries < 0) cfg.upstreamRetries = 0;
  if (cfg.backupKeep < 1) cfg.backupKeep = 1;

  const paths = {
    configDir: path.join(effectiveRoot, 'config'),
    modelsFile: path.join(effectiveRoot, 'config', 'models.json'),
    modelsDefaultFile: path.join(effectiveRoot, 'config', 'models.default.json'),
    exclusionsFile: path.join(effectiveRoot, 'config', 'exclusions.json'),
    metadataFile: path.join(effectiveRoot, 'config', 'metadata.json'),
    backupsDir: path.join(effectiveRoot, 'backups'),
    stateDir: path.join(effectiveRoot, 'state'),
    logsDir: path.join(effectiveRoot, 'logs'),
    runDir: path.join(effectiveRoot, 'run'),
    syncLockFile: path.join(effectiveRoot, 'state', 'sync.lock'),
    verificationFile: path.join(effectiveRoot, 'state', 'verification.json'),
    deploymentsFile: path.join(effectiveRoot, 'state', 'deployments.json'),
    syncStatusFile: path.join(effectiveRoot, 'state', 'sync-status.json'),
  };
  Object.assign(paths, overrides.paths || {});
  cfg.paths = paths;
  if (!cfg.logFile) cfg.logFile = path.join(paths.logsDir, 'bridge.log');

  Object.assign(cfg, overrides);
  return cfg;
}
