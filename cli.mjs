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
import { ModelRegistry, registryHash } from './lib/registry.mjs';
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
