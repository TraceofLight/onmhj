const fs = require('fs');
const { eventDedupeKey, isStatusDowngrade, loadEvents } = require('./events');
const { acquireLock, releaseLock } = require('./locks');
const { eventFile, eventSpoolLockFile } = require('./paths');
const { sanitizeEvent } = require('./references');
const { applyReplayReplacement, recoverSessionReplayUnlocked, replayReplacementPlan } = require('./replay');
const { appendLine, utcDateKey } = require('./util');

const EVENT_SPOOL_LOCK_TIMEOUT_MS = 10 * 1000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function appendEventRecordUnlocked(cfg, event) {
  const file = eventFile(cfg, utcDateKey(new Date(event.tsUtc || event.ts)));
  const key = eventDedupeKey(event);
  if (key && loadEvents(file).some(existing => eventDedupeKey(existing) === key)) return false;
  appendLine(file, JSON.stringify(event));
  return true;
}

function appendEventRecord(cfg, event) {
  return withEventSpoolLock(cfg, () => appendEventRecordUnlocked(cfg, event));
}

function upsertEventRecordUnlocked(cfg, event) {
  if (!event.sourceId) return appendEventRecordUnlocked(cfg, event);
  const file = eventFile(cfg, utcDateKey(new Date(event.tsUtc || event.ts)));
  const clean = sanitizeEvent(event);
  const events = loadEvents(file);
  const index = events.findIndex(existing => existing.sourceId === clean.sourceId);
  if (index < 0) {
    appendLine(file, JSON.stringify(clean));
    return true;
  }
  if (JSON.stringify(events[index]) === JSON.stringify(clean)) return false;
  if (isStatusDowngrade(events[index], clean)) return false;
  events[index] = clean;
  fs.writeFileSync(file, events.map(item => JSON.stringify(item)).join('\n') + '\n');
  return true;
}

function upsertEventRecord(cfg, event) {
  return withEventSpoolLock(cfg, () => upsertEventRecordUnlocked(cfg, event));
}

function replaceLocalSessionEvents(cfg, provider, sessionIds, events, turnIds) {
  return withEventSpoolLock(cfg, () => (
    applyReplayReplacement(cfg, replayReplacementPlan(cfg, provider, sessionIds, events, turnIds))
  ));
}

function withEventSpoolLock(cfg, action) {
  const lock = eventSpoolLockFile(cfg);
  const deadline = Date.now() + EVENT_SPOOL_LOCK_TIMEOUT_MS;
  while (!acquireLock(lock)) {
    if (Date.now() >= deadline) throw new Error('event spool is busy');
    Atomics.wait(LOCK_WAIT, 0, 0, LOCK_RETRY_MS);
  }
  try {
    recoverSessionReplayUnlocked(cfg);
    return action();
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  appendEventRecord,
  replaceLocalSessionEvents,
  upsertEventRecord,
  withEventSpoolLock,
};
