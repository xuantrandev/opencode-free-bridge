// Filesystem helpers: safe JSON reads, atomic writes, advisory lock files.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readFileStat(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

/** Read + parse JSON. Returns { ok, value, error } and never throws. */
export function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, value: JSON.parse(text), error: null };
  } catch (err) {
    return { ok: false, value: null, error: err };
  }
}

/** Serialize `value` and atomically replace `file` (tmp + fsync + rename). */
export async function atomicWriteJson(file, value, { pretty = true } = {}) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const data = JSON.stringify(value, null, pretty ? 2 : 0) + '\n';
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
  try {
    const dh = await fsp.open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch { /* fsync on directories is best-effort */ }
}

export function sha256Short(input, len = 16) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, len);
}

/**
 * Best-effort advisory lock backed by a lock file. Used to prevent overlapping
 * synchronizations across processes (the in-process guard handles the common
 * case). Stale locks older than `staleMs` are reclaimed.
 */
export function acquireFileLock(lockFile, { staleMs = 10 * 60 * 1000 } = {}) {
  ensureDir(path.dirname(lockFile));
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return {
      acquired: true,
      release: () => {
        try {
          fs.unlinkSync(lockFile);
        } catch { /* already gone */ }
      },
    };
  } catch (err) {
    if (err?.code !== 'EEXIST') return { acquired: false, release: () => {}, error: err };
    const st = readFileStat(lockFile);
    if (st.exists && Date.now() - st.mtimeMs > staleMs) {
      try {
        fs.unlinkSync(lockFile);
        return acquireFileLock(lockFile, { staleMs });
      } catch { /* raced */ }
    }
    return { acquired: false, release: () => {}, stale: false };
  }
}

export function pruneOldFiles(dir, { pattern = /./, keep = 20 } = {}) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => pattern.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(keep)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
}
