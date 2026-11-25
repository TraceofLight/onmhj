const fs = require('fs');
const path = require('path');
const { readJson } = require('./util');

const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readJson(file, null);
  const stale = existing && existing.ts && Date.now() - Date.parse(existing.ts) > LOCK_STALE_MS;
  if (existing && ((!existing.pid && stale) || (existing.pid && !pidAlive(existing.pid)))) {
    try { fs.unlinkSync(file); } catch {}
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }) + '\n', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(file) {
  const existing = readJson(file, null);
  if (!existing || existing.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch {}
}

function lockOwned(file) {
  const existing = readJson(file, null);
  return Boolean(existing && existing.pid === process.pid);
}

module.exports = {
  acquireLock,
  lockOwned,
  releaseLock,
};
