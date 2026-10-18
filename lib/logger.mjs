// Minimal structured logger. Writes human-readable lines to stdout/stderr
// (captured by systemd/journald) and optionally appends to a log file.

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function formatValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  const s = String(v);
  return /\s/.test(s) ? JSON.stringify(s) : s;
}

export function createLogger({ level = 'info', file = '', silent = false, console: consoleMode = 'stdout' } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  let stream = null;
  let streamFailed = false;

  if (file && !silent) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
        try {
          fs.renameSync(file, `${file}.1`);
        } catch { /* non-fatal */ }
      }
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => {
        streamFailed = true;
        stream = null;
      });
    } catch {
      streamFailed = true;
    }
  }

  function write(levelName, msg, fields) {
    if (LEVELS[levelName] < threshold) return;
    const ts = new Date().toISOString();
    let extras = '';
    if (fields && typeof fields === 'object') {
      const parts = [];
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        const f = formatValue(v);
        if (f !== '') parts.push(`${k}=${f}`);
      }
      if (parts.length) extras = ' ' + parts.join(' ');
    }
    const line = `${ts} ${levelName.toUpperCase().padEnd(5)} [opencode-free-bridge] ${msg}${extras}`;
    if (!silent && consoleMode !== 'none') {
      (levelName === 'error' ? process.stderr : process.stdout).write(line + '\n');
    }
    if (stream && !streamFailed) {
      try {
        stream.write(line + '\n');
      } catch { /* non-fatal */ }
    }
  }

  return {
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (prefix, extraFields = {}) => {
      const wrap = (fn) => (msg, fields) => fn(`${prefix} ${msg}`, { ...extraFields, ...fields });
      return {
        debug: wrap(write.bind(null, 'debug')),
        info: wrap(write.bind(null, 'info')),
        warn: wrap(write.bind(null, 'warn')),
        error: wrap(write.bind(null, 'error')),
      };
    },
    close: () => {
      if (stream) {
        try {
          stream.end();
        } catch { /* non-fatal */ }
        stream = null;
      }
    },
  };
}

export const silentLogger = createLogger({ silent: true });
