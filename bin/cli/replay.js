const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isStatusDowngrade, isTranscriptSessionEvent, loadEvents } = require('./events');
const { eventFile, sessionIngestDir } = require('./paths');
const { sanitizeEvent } = require('./references');
const { utcDateKey } = require('./util');

function replayJournalFile(cfg) {
  return path.join(sessionIngestDir(cfg), 'replay-journal.json');
}

function removeFileIfPresent(file) {
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
}

function cleanupReplayFiles(files) {
  for (const file of files) {
    removeFileIfPresent(file.temporary);
    removeFileIfPresent(file.backup);
  }
}

function recoverSessionReplayUnlocked(cfg) {
  const journalFile = replayJournalFile(cfg);
  if (!fs.existsSync(journalFile)) return false;
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  for (const file of journal.files) {
    if (file.existed) fs.copyFileSync(file.backup, file.target);
    else removeFileIfPresent(file.target);
  }
  removeFileIfPresent(journalFile);
  cleanupReplayFiles(journal.files);
  return true;
}

function replayReplacementPlan(cfg, provider, sessionIds, events, turnIds) {
  const owned = new Set(sessionIds);
  const dir = path.join(cfg.stateDir, 'events');
  const nextByFile = new Map();
  let removed = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'));
  } catch {}
  const incoming = new Map(events.map(event => [event.sourceId, event]));
  // Judged on the stored events before removal, so a protected completed turn survives in any date file.
  const protectedIds = new Set();
  for (const name of files) {
    const file = path.join(dir, name);
    const current = loadEvents(file);
    const kept = current.filter(event => {
      if (incoming.has(event.sourceId) && isStatusDowngrade(event, incoming.get(event.sourceId))) {
        protectedIds.add(event.sourceId);
        return true;
      }
      const replace = isTranscriptSessionEvent(event) &&
        event.deviceId === cfg.deviceId &&
        event.provider === provider &&
        owned.has(event.sessionId) &&
        (!turnIds || turnIds.has(event.turnId));
      if (replace) removed += 1;
      return !replace;
    });
    if (kept.length !== current.length) nextByFile.set(file, kept);
  }
  for (const event of events) {
    if (protectedIds.has(event.sourceId)) continue;
    const clean = sanitizeEvent(event);
    const file = eventFile(cfg, utcDateKey(new Date(clean.tsUtc || clean.ts)));
    const next = nextByFile.get(file) || loadEvents(file);
    const index = next.findIndex(existing => existing.sourceId === clean.sourceId);
    if (index < 0) next.push(clean);
    else next[index] = clean;
    nextByFile.set(file, next);
  }
  return {
    changed: removed + events.length,
    files: [...nextByFile].map(([target, next]) => ({
      target,
      raw: next.length ? next.map(event => JSON.stringify(event)).join('\n') + '\n' : '',
    })),
  };
}

function applyReplayReplacement(cfg, plan) {
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const files = plan.files
    .map(file => ({
      ...file,
      original: fs.existsSync(file.target) ? fs.readFileSync(file.target, 'utf8') : null,
    }))
    .filter(file => file.raw !== file.original)
    .map(file => ({
      ...file,
      existed: file.original !== null,
      temporary: file.raw ? `${file.target}.replay-${token}.next` : '',
      backup: file.original !== null ? `${file.target}.replay-${token}.backup` : '',
    }));
  if (!files.length) return 0;

  const journalFile = replayJournalFile(cfg);
  const journalTemp = `${journalFile}.next`;
  let journalWritten = false;
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      if (file.temporary) fs.writeFileSync(file.temporary, file.raw, { mode: 0o600 });
      if (file.backup) fs.copyFileSync(file.target, file.backup);
    }
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(journalTemp, JSON.stringify({
      files: files.map(({ target, temporary, backup, existed }) => ({ target, temporary, backup, existed })),
    }, null, 2) + '\n');
    fs.renameSync(journalTemp, journalFile);
    journalWritten = true;

    for (const file of files) {
      if (file.temporary) fs.renameSync(file.temporary, file.target);
      else removeFileIfPresent(file.target);
    }
    removeFileIfPresent(journalFile);
    journalWritten = false;
    cleanupReplayFiles(files);
    return plan.changed;
  } catch (error) {
    removeFileIfPresent(journalTemp);
    if (journalWritten) recoverSessionReplayUnlocked(cfg);
    else cleanupReplayFiles(files);
    throw error;
  }
}

module.exports = {
  applyReplayReplacement,
  recoverSessionReplayUnlocked,
  replayReplacementPlan,
};
