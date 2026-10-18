#!/usr/bin/env node
// Management CLI for opencode-free-bridge.
//
//   opencode-free-bridge models            list active models
//   opencode-free-bridge models sync       run one discovery + deploy cycle
//   opencode-free-bridge models status     registry / sync / verification status
//   opencode-free-bridge models exclude ID exclude a model (pattern or id)
//   opencode-free-bridge models include ID un-exclude / force-include a model
//   opencode-free-bridge models verify     run inference verification on demand
//   opencode-free-bridge status            service + health overview
//   opencode-free-bridge logs [-n N] [-f]  tail bridge logs
//   opencode-free-bridge reload            SIGHUP the bridge (reload registry)
//   opencode-free-bridge version

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, matchesAny } from './lib/config.mjs';
import { createLogger } from './lib/logger.mjs';
import { ModelRegistry, normalizeRegistry, registryHash } from './lib/registry.mjs';
import { OpenCodeClient } from './lib/opencode-client.mjs';
import { ModelSyncService, fetchJsonWithTimeout } from './lib/sync.mjs';
import { createUpstreamTest, loadVerificationState, verifyModels, verificationSummary } from './lib/verify.mjs';
import { VERSION } from './lib/version.mjs';

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(name);
}

function flagValue(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
}

function positionals() {
  const withValue = new Set(['-n', '--reason', '--port']);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      if (withValue.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const wantsJson = flag('--json');

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function makeLogger(config, quiet = false) {
  return createLogger({
    level: quiet ? 'warn' : (process.env.OPENCODE_FREE_BRIDGE_VERBOSE ? 'debug' : 'info'),
    file: quiet ? '' : config.logFile,
    console: wantsJson ? 'none' : 'stdout',
  });
}

function makeRegistry(config, logger) {
  const registry = new ModelRegistry({ paths: config.paths, logger });
  registry.load();
  return registry;
}

function makeSyncService(config, registry, logger) {
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
  return new ModelSyncService({ config, registry, client, logger, selfUrl: `http://127.0.0.1:${config.port}` });
}

async function bridgeHealth(config) {
  const res = await fetchJsonWithTimeout(`http://127.0.0.1:${config.port}/health`, { timeoutMs: 2500 });
  return res;
}

// ------------------------------------------------------------------ commands

async function cmdModelsList(config) {
  const logger = createLogger({ silent: true });
  const registry = makeRegistry(config, logger);
  const snapshot = registry.snapshot();
  const rows = snapshot.models.map((m) => ({
    id: m.id,
    status: m.status,
    context: m.context,
    output: m.output,
    addedAt: m.addedAt,
    verifiedAt: m.verifiedAt,
    failCount: m.failCount,
    freeReason: m.freeReason,
  }));
  if (wantsJson) {
    printJson({
      models: rows,
      count: rows.length,
      hash: snapshot.hash,
      generation: snapshot.generation,
      lastUpdated: snapshot.lastUpdated,
      lastSync: snapshot.lastSync,
      exclusions: registry.exclusions,
      source: registry.loadedFrom,
    });
    return 0;
  }
  console.log(`# model registry (${rows.length} models, hash ${snapshot.hash}, generation ${snapshot.generation})`);
  if (rows.length === 0) {
    console.log('  (empty — run `opencode-free-bridge models sync`)');
  }
  for (const m of rows) {
    const meta = [m.context ? `ctx=${m.context}` : null, m.output ? `max=${m.output}` : null].filter(Boolean).join(' ');
    console.log(`  ${pad(m.id, 32)} ${pad(m.status, 19)} ${meta}`);
  }
  if (registry.exclusions.exclude.length) {
    console.log(`# excluded: ${registry.exclusions.exclude.join(', ')}`);
    for (const [pattern, reason] of Object.entries(registry.exclusions.reasons || {})) {
      console.log(`  ${pad(pattern, 32)} ${reason}`);
    }
  }
  if (registry.exclusions.include.length) {
    console.log(`# force-included: ${registry.exclusions.include.join(', ')}`);
  }
  console.log(`# last updated: ${snapshot.lastUpdated || 'never'}   last sync: ${snapshot.lastSync || 'never'} (${snapshot.lastSyncStatus || 'n/a'})`);
  return 0;
}

async function cmdModelsSync(config) {
  const quiet = flag('--quiet');
  const logger = makeLogger(config, quiet);
  const registry = makeRegistry(config, logger);
  const sync = makeSyncService(config, registry, logger);
  const result = await sync.runOnce({ trigger: 'cli' });
  if (wantsJson) printJson(result);
  else if (!quiet) {
    console.log(`sync: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    if (result.added?.length) console.log(`  added:   ${result.added.join(', ')}`);
    if (result.removed?.length) console.log(`  removed: ${result.removed.join(', ')}`);
    if (result.error) console.log(`  error:   ${result.error.message || result.error}`);
  }
  return ['failed', 'rolled-back'].includes(result.status) ? 1 : 0;
}

async function cmdModelsStatus(config) {
  const logger = createLogger({ silent: true });
  const registry = makeRegistry(config, logger);
  const snapshot = registry.snapshot();
  const verification = loadVerificationState(config.paths.verificationFile);
  const health = await bridgeHealth(config);
  const deployments = (() => {
    try {
      return JSON.parse(fs.readFileSync(config.paths.deploymentsFile, 'utf8')).deployments || [];
    } catch {
      return [];
    }
  })();
  const out = {
    registry: {
      file: registry.loadedFrom,
      count: snapshot.models.length,
      hash: snapshot.hash,
      generation: snapshot.generation,
      lastUpdated: snapshot.lastUpdated,
      lastSync: snapshot.lastSync,
      lastSyncStatus: snapshot.lastSyncStatus,
      lastSyncError: snapshot.lastSyncError ?? null,
    },
    exclusions: registry.exclusions,
    verification: verificationSummary(verification),
    bridge: health.status === 0
      ? { running: false, error: health.error?.message || 'unreachable' }
      : { running: true, health: health.json },
    recentDeployments: deployments.slice(-5).reverse(),
  };
  if (wantsJson) {
    printJson(out);
    return 0;
  }
  console.log(`registry:     ${out.registry.count} models  hash=${out.registry.hash}  generation=${out.registry.generation}`);
  console.log(`file:         ${out.registry.file || '(none)'}`);
  console.log(`last sync:    ${out.registry.lastSync || 'never'} (${out.registry.lastSyncStatus || 'n/a'})`);
  if (out.registry.lastSyncError) console.log(`sync error:   ${out.registry.lastSyncError}`);
  console.log(`excluded:     ${out.exclusions.exclude.join(', ') || '(none)'}`);
  console.log(`included:     ${out.exclusions.include.join(', ') || '(none)'}`);
  console.log(`verification: ${out.verification.verified} verified, ${out.verification.failed} failed of ${out.verification.total} recorded`);
  console.log(`bridge:       ${out.bridge.running ? `running (${out.bridge.health?.modelCount} models, upstream ${out.bridge.health?.upstream}, sync ${out.bridge.health?.modelSync})` : `not running (${out.bridge.error})`}`);
  if (out.recentDeployments.length) {
    console.log('recent deployments:');
    for (const d of out.recentDeployments) {
      console.log(`  ${d.at}  ${pad(d.status, 12)} +${(d.added || []).length}/-${(d.removed || []).length}  ${d.error || ''}`);
    }
  }
  return 0;
}

function idsFromPattern(config, registry, pattern) {
  // return concrete discovered ids currently deployed that match the pattern
  return registry.models.filter((m) => m.id === pattern || matchesAny(m.id, [pattern])).map((m) => m.id);
}

async function cmdModelsExclude(config, patternArg) {
  const reason = flagValue('--reason');
  if (!patternArg) {
    console.error('usage: opencode-free-bridge models exclude MODEL_ID [--reason "..."]');
    return 2;
  }
  const logger = makeLogger(config, true);
  const registry = makeRegistry(config, logger);
  if (registry.exclusions.exclude.includes(patternArg)) {
    console.log(`already excluded: ${patternArg}`);
  } else {
    await registry.setExclusion(patternArg, reason || null);
    console.log(`excluded: ${patternArg}${reason ? ` (${reason})` : ''}`);
  }
  if (!flag('--no-deploy')) {
    const matching = idsFromPattern(config, registry, patternArg);
    if (matching.length) {
      const candidate = registry.models.filter((m) => !matching.includes(m.id));
      registry.capturePrevious();
      await registry.deploy(candidate, { reason: `exclude:${patternArg}` });
      console.log(`removed from active registry: ${matching.join(', ')}`);
      const health = await bridgeHealth(config);
      console.log(health.status !== 0
        ? 'bridge will hot-reload the registry automatically'
        : 'note: bridge not running; the change will apply on next start');
    } else {
      console.log('no active models match the pattern (future discoveries will be filtered)');
    }
  }
  return 0;
}

async function cmdModelsInclude(config, patternArg) {
  if (!patternArg) {
    console.error('usage: opencode-free-bridge models include MODEL_ID [--no-sync]');
    return 2;
  }
  const logger = makeLogger(config, true);
  const registry = makeRegistry(config, logger);
  const removedPatterns = registry.exclusions.exclude.filter((p) => p === patternArg);
  for (const p of removedPatterns) await registry.removeExclusion(p);
  await registry.setInclude(patternArg);
  console.log(`included: ${patternArg}${removedPatterns.length ? ' (removed from exclusions)' : ''}`);
  if (!flag('--no-sync')) {
    const sync = makeSyncService(config, registry, logger);
    const result = await sync.runOnce({ trigger: 'include' });
    if (wantsJson) printJson(result);
    else console.log(`sync: ${result.status}${result.added?.length ? ` added: ${result.added.join(', ')}` : ''}`);
    return ['failed', 'rolled-back'].includes(result.status) ? 1 : 0;
  }
  return 0;
}

async function cmdModelsVerify(config) {
  const logger = makeLogger(config, true);
  const registry = makeRegistry(config, logger);
  const explicit = positionals().slice(2); // after 'models verify'
  const client = new OpenCodeClient({
    upstream: config.upstream,
    provider: config.provider,
    agent: config.agent,
    timeoutMs: config.verifyTimeoutMs,
    retries: 0,
    logger,
  });
  const targets = explicit.length
    ? registry.models.filter((m) => explicit.includes(m.id))
    : registry.models;
  if (targets.length === 0) {
    console.log('no models to verify');
    return 0;
  }
  const test = createUpstreamTest({ client });
  const { results, globalFailure } = await verifyModels({
    models: targets,
    test,
    stateFile: config.paths.verificationFile,
    timeoutMs: config.verifyTimeoutMs,
    concurrency: config.verifyConcurrency,
    maxPerRun: explicit.length ? explicit.length : config.verifyMaxPerRun,
    retryHours: config.verifyRetryHours,
    logger,
  });
  await registry.updateMeta((reg) => {
    const byId = new Map(results.map((r) => [r.id, r]));
    reg.models = reg.models.map((m) => {
      const r = byId.get(m.id);
      if (!r) return m;
      return {
        ...m,
        status: r.status === 'verified' ? 'verified' : 'verification-failed',
        verifiedAt: r.status === 'verified' ? r.checkedAt : m.verifiedAt,
        failCount: r.failCount,
      };
    });
  });
  if (wantsJson) {
    printJson({ results, globalFailure, attempted: results.length });
    return 0;
  }
  for (const r of results) console.log(`  ${pad(r.id, 32)} ${pad(r.status, 20)} ${r.lastError || ''}`);
  if (globalFailure) console.log('warning: all tests failed to connect — treating as upstream outage, nothing removed');
  return 0;
}

async function cmdHealth(config) {
  const quiet = flag('--quiet');
  const readyOnly = flag('--ready');
  const health = await fetchJsonWithTimeout(`http://127.0.0.1:${config.port}/health`, { timeoutMs: 2500 });
  const readiness = await fetchJsonWithTimeout(`http://127.0.0.1:${config.port}/health/ready`, { timeoutMs: 2500 });
  const live = health.status === 200 && health.json?.ok !== false && health.json?.bridge?.ok !== false;
  const readyOk = readiness.status === 200 && readiness.json?.ready === true;
  const passed = readyOnly ? readyOk : live;
  if (wantsJson) {
    printJson({
      live,
      ready: readyOk,
      health: health.status === 0 ? { error: health.error?.message || 'unreachable' } : health.json,
      readiness: readiness.status === 0 ? { error: readiness.error?.message || 'unreachable' } : readiness.json,
    });
    return passed ? 0 : 1;
  }
  if (quiet) return passed ? 0 : 1;
  if (health.status === 0) {
    console.log(`bridge:   DOWN (${health.error?.message || 'unreachable'})`);
    return 1;
  }
  const h = health.json ?? {};
  console.log(`bridge:   UP (${h.bridge?.version ?? '?'}, up ${h.bridge?.uptimeSeconds ?? '?'}s, pid ${h.bridge?.pid ?? '?'})`);
  console.log(`upstream: ${h.upstream ?? 'unknown'}${h.upstreamDetail?.latencyMs != null ? ` (${h.upstreamDetail.latencyMs}ms)` : ''}`);
  console.log(`registry: ${h.modelCount ?? 0} models, generation ${h.registry?.generation ?? 0}, hash ${h.registryHash ?? '-'}`);
  console.log(`last sync: ${h.lastSync || 'never'} (${h.lastSyncStatus || 'n/a'})${h.lastSyncError ? ` — ${h.lastSyncError}` : ''}`);
  console.log(`ready:    ${readyOk ? 'yes' : 'no'}${readiness.json ? ` (${JSON.stringify(readiness.json.checks || {})})` : ''}`);
  return passed ? 0 : 1;
}

function readJsonFileSafe(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function cmdConfigVerify(config) {
  const problems = [];
  const notes = [];
  const logger = createLogger({ silent: true });
  const registry = makeRegistry(config, logger);

  const modelsRead = fs.existsSync(config.paths.modelsFile) ? readJsonFileSafe(config.paths.modelsFile) : { ok: true, value: null };
  if (!modelsRead.ok) problems.push(`config/models.json: ${modelsRead.error?.message || 'unreadable'}`);
  const rawModels = modelsRead.value;
  const { valid, errors } = rawModels ? normalizeRegistry(rawModels) : { valid: true, errors: [] };
  if (rawModels && !valid) problems.push(`config/models.json: ${errors[0] || 'invalid'}`);
  for (const error of errors.slice(0, 5)) notes.push(`models.json: ${error}`);

  const exclusions = registry.exclusions;
  for (const pattern of [...exclusions.exclude, ...exclusions.include]) {
    if (typeof pattern !== 'string' || !pattern.trim()) problems.push('exclusions.json: patterns must be non-empty strings');
    else if (pattern.startsWith('re:')) {
      try { new RegExp(pattern.slice(3)); } catch (err) { problems.push(`exclusions.json: invalid regex '${pattern}' (${err.message})`); }
    }
  }
  const exclusionsRead = fs.existsSync(config.paths.exclusionsFile) ? readJsonFileSafe(config.paths.exclusionsFile) : { ok: true, value: null };
  if (!exclusionsRead.ok) problems.push(`config/exclusions.json: ${exclusionsRead.error?.message || 'unreadable'}`);
  const rawExclusions = exclusionsRead.value;
  if (rawExclusions && !Array.isArray(rawExclusions.exclude)) problems.push('exclusions.json: "exclude" must be an array');
  if (rawExclusions && !Array.isArray(rawExclusions.include)) problems.push('exclusions.json: "include" must be an array');

  const metadataRead = fs.existsSync(config.paths.metadataFile) ? readJsonFileSafe(config.paths.metadataFile) : { ok: true, value: null };
  if (!metadataRead.ok) problems.push(`config/metadata.json: ${metadataRead.error?.message || 'unreadable'}`);
  const rawMetadata = metadataRead.value;
  if (rawMetadata !== null && (typeof rawMetadata !== 'object' || Array.isArray(rawMetadata))) {
    problems.push('metadata.json: must be a JSON object keyed by model id');
  }

  for (const warning of config.warnings) notes.push(warning);

  const out = {
    ok: problems.length === 0,
    problems,
    notes,
    config: {
      host: config.host,
      port: config.port,
      upstream: config.upstream,
      discovery: config.discoveryUrl || 'local opencode CLI',
      apiKey: config.apiKey ? 'set' : 'unset',
      rateLimitRpm: config.rateLimitRpm,
      allowNonLoopback: config.allowNonLoopback,
      corsAllowedOrigins: config.corsAllowedOrigins,
      syncIntervalMinutes: config.syncIntervalMinutes,
      paths: config.paths,
    },
    registry: {
      source: registry.loadedFrom,
      models: registry.models.length,
      generation: registry.registry.generation ?? 0,
      hash: registryHash(registry.models),
    },
    exclusions: { exclude: exclusions.exclude, include: exclusions.include },
  };

  if (flag('--online')) {
    const upstream = await new OpenCodeClient({ upstream: config.upstream, logger }).health({ timeoutMs: 2500 });
    out.upstream = { ok: upstream.ok, latencyMs: upstream.latencyMs ?? null, version: upstream.version ?? null };
    if (!upstream.ok) notes.push(`upstream ${config.upstream} is not reachable right now`);
  }

  if (wantsJson) {
    printJson(out);
    return out.ok ? 0 : 1;
  }
  console.log(out.ok ? 'config: OK' : 'config: INVALID');
  console.log(`  registry:   ${out.registry.models} models from ${out.registry.source || '(none)'}`);
  console.log(`  exclusions: ${out.exclusions.exclude.join(', ') || '(none)'}`);
  console.log(`  discovery:  ${out.config.discovery}`);
  console.log(`  api key:    ${out.config.apiKey}`);
  for (const p of problems) console.log(`  problem: ${p}`);
  for (const n of notes) console.log(`  note:    ${n}`);
  if (out.upstream) console.log(`  upstream:   ${out.upstream.ok ? `ok (${out.upstream.latencyMs}ms)` : 'unreachable'}`);
  return out.ok ? 0 : 1;
}

async function cmdRestart(config) {
  const pidFile = path.join(config.paths.runDir, 'bridge.pid');
  let pid = null;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  } catch { /* no pid file */ }
  if ((!pid || !Number.isFinite(pid)) && fs.existsSync('/.dockerenv')) pid = 1;
  if (!pid || !Number.isFinite(pid)) {
    console.error('bridge is not running (no pid file)');
    return 1;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`failed to signal pid ${pid}: ${err.message}`);
    return 1;
  }
  console.log(`sent SIGTERM to bridge pid ${pid} (graceful shutdown); the restart policy will bring it back`);
  return 0;
}

async function cmdStatus(config) {
  const logger = createLogger({ silent: true });
  const registry = makeRegistry(config, logger);
  const health = await bridgeHealth(config);
  const upstream = await new OpenCodeClient({ upstream: config.upstream, logger }).health({ timeoutMs: 2500 });
  const out = {
    bridge: {
      url: `http://127.0.0.1:${config.port}`,
      running: health.status !== 0,
      health: health.json ?? null,
      error: health.status === 0 ? (health.error?.message || 'unreachable') : null,
    },
    upstream: {
      url: config.upstream,
      connected: upstream.ok,
      latencyMs: upstream.latencyMs ?? null,
      version: upstream.version ?? null,
    },
    models: registry.models.length,
    modelSync: config.autoSync ? 'enabled' : 'disabled',
    syncIntervalMinutes: config.syncIntervalMinutes,
    version: VERSION,
  };
  if (wantsJson) {
    printJson(out);
    return 0;
  }
  console.log(`bridge:   ${out.bridge.running ? `UP    ${out.bridge.url}` : `DOWN  ${out.bridge.url} (${out.bridge.error})`}`);
  console.log(`upstream: ${out.upstream.connected ? `UP    ${out.upstream.url}${out.upstream.version ? ` (opencode ${out.upstream.version})` : ''}` : `DOWN  ${out.upstream.url}`}`);
  console.log(`models:   ${out.models}`);
  console.log(`sync:     ${out.modelSync} every ${out.syncIntervalMinutes}m`);
  if (out.bridge.health) {
    const h = out.bridge.health;
    console.log(`last sync: ${h.lastSync || 'never'} (${h.lastSyncStatus || 'n/a'})`);
  }
  return 0;
}

function cmdLogs(config) {
  const n = flagValue('-n', '100');
  const follow = flag('-f');
  if (!config.logFile || config.logFile === '-' || config.logFile === 'stdout' || config.logFile === 'stderr') {
    console.log('logging to stdout (LOG_FILE=-). In Docker use: docker compose logs -f opencode-bridge');
    return 0;
  }
  const files = [config.logFile, path.join(config.paths.logsDir, 'opencode-serve.log')].filter((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
  if (files.length === 0) {
    const args = ['-u', 'opencode-free-bridge.service', '-u', 'opencode-serve.service', '-n', n];
    if (follow) args.push('-f');
    const child = spawn('journalctl', args, { stdio: 'inherit' });
    return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
  }
  const args = ['-n', n, ...(follow ? ['-F'] : []), ...files];
  const child = spawn('tail', args, { stdio: 'inherit' });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

async function cmdReload(config) {
  const pidFile = path.join(config.paths.runDir, 'bridge.pid');
  let pid = null;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  } catch { /* no pid file */ }
  if (!pid || !Number.isFinite(pid)) {
    // fall back to the process listening on the bridge port
    const health = await bridgeHealth(config);
    if (health.status === 0) {
      console.log('bridge is running but no pid file was found; it hot-reloads config/models.json automatically');
      return 0;
    }
    console.error('bridge is not running');
    return 1;
  }
  try {
    process.kill(pid, 'SIGHUP');
    console.log(`sent SIGHUP to bridge pid ${pid} (registry reload)`);
    return 0;
  } catch (err) {
    console.error(`failed to signal pid ${pid}: ${err.message}`);
    return 1;
  }
}

function usage() {
  console.log(`opencode-free-bridge ${VERSION}

usage: opencode-free-bridge <command> [options]

commands:
  models [list] [--json]              list active models from the registry
  models sync [--json] [--quiet]      discover models and deploy changes now
  models status [--json]              registry, sync and verification status
  models exclude ID [--reason TEXT]   exclude a model (glob patterns allowed)
  models include ID [--no-sync]       un-exclude / force-include a model
  models verify [ID...] [--json]      run inference verification
  status [--json]                     bridge + upstream health overview
  health [--json] [--quiet] [--ready] liveness/readiness probe (exit code for scripts)
  config verify [--json] [--online]   validate registry, exclusions, metadata, env
  restart                             gracefully stop the bridge (restart policy revives it)
  logs [-n N] [-f]                    tail bridge logs (journalctl fallback)
  reload                              SIGHUP the bridge to reload the registry
  version                             print the bridge version
`);
  return 0;
}

export async function runCli(args = argv, { env = process.env } = {}) {
  const config = loadConfig({ env });
  const [cmd, sub] = args.filter((a) => !a.startsWith('-'));
  switch (cmd) {
    case 'models':
      switch (sub) {
        case undefined:
        case 'list':
          return cmdModelsList(config);
        case 'sync':
          return cmdModelsSync(config);
        case 'status':
          return cmdModelsStatus(config);
        case 'exclude':
          return cmdModelsExclude(config, positionals()[2]);
        case 'include':
          return cmdModelsInclude(config, positionals()[2]);
        case 'verify':
          return cmdModelsVerify(config);
        default:
          console.error(`unknown models subcommand: ${sub}`);
          return usage();
      }
    case 'sync':
      return cmdModelsSync(config);
    case 'status':
      return cmdStatus(config);
    case 'health':
    case 'healthz':
      return cmdHealth(config);
    case 'config':
      switch (sub) {
        case 'verify':
        case 'check':
          return cmdConfigVerify(config);
        default:
          console.error(`unknown config subcommand: ${sub ?? '(none)'} (expected: verify)`);
          return usage();
      }
    case 'restart':
      return cmdRestart(config);
    case 'logs':
      return cmdLogs(config);
    case 'reload':
      return cmdReload(config);
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return 0;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return usage();
    default:
      console.error(`unknown command: ${cmd}`);
      return usage();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`error: ${err?.message || err}`);
    process.exitCode = 1;
  });
}
