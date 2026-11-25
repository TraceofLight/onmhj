const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SessionParserError,
  parseClaudeRecord,
  parseCodexRecord,
  parseDshRecord,
} = require('../session-parsers');
const { replaceLocalSessionEvents, upsertEventRecord, withEventSpoolLock } = require('./event-spool');
const { acquireLock, releaseLock } = require('./locks');
const { writeInternalLog } = require('./log');
const {
  cursorFile,
  quarantineFile,
  sessionIngestDir,
  sessionIngestLockFile,
  sessionSourcesFile,
} = require('./paths');
const { isCompressedSession, readJsonLines } = require('./session-files');
const {
  SESSION_PARSER_VERSION,
  canonicalSessionPath,
  discoverSessionSources,
  sessionSuccessor,
} = require('./session-sources');
const { localDateKey, readJson, writeJson } = require('./util');

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function affectedDate(cfg, state, file) {
  const ts = state.turn && state.turn.tsUtc;
  if (ts && !Number.isNaN(new Date(ts).getTime())) return localDateKey(new Date(ts), cfg.timeZone);
  const match = String(file).match(/[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/]/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return localDateKey(fs.statSync(file).mtime, cfg.timeZone);
}

function schemaSignature(record) {
  if (!record) return 'invalid-json';
  return [record.type, record.payload && record.payload.type, record.message && record.message.role]
    .filter(Boolean)
    .join(':') || 'unknown';
}

function normalizedSessionEvent(cfg, turn) {
  const ts = new Date(turn.tsUtc);
  if (Number.isNaN(ts.getTime())) throw new SessionParserError('session_invalid_timestamp');
  const event = {
    schemaVersion: 1,
    event: 'AISessionTurn',
    source: turn.source || `${turn.provider}-transcript`,
    sourceId: `${turn.provider}:${turn.sessionId}:${turn.turnId}`,
    provider: turn.provider,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    tsUtc: ts.toISOString(),
    localDate: localDateKey(ts, cfg.timeZone),
    timeZone: cfg.timeZone,
    deviceId: cfg.deviceId,
    cwd: turn.cwd,
    status: turn.status,
  };
  if (turn.model) event.model = turn.model;
  if (turn.toolNames && turn.toolNames.length) event.toolNames = turn.toolNames;
  event.prompt = turn.prompt;
  if (turn.assistantResponse) event.assistantResponse = turn.assistantResponse;
  return event;
}

function parserFor(provider) {
  if (provider === 'codex') return parseCodexRecord;
  if (provider === 'claude') return parseClaudeRecord;
  if (provider === 'dsh') return parseDshRecord;
  throw new SessionParserError('unsupported_session_provider');
}

async function ingestSessionFile(cfg, source, cursors) {
  const file = canonicalSessionPath(source.path);
  const aliases = source.predecessor
    ? [source.predecessor]
    : Object.keys(cursors.files).filter(key => key !== file && canonicalSessionPath(key) === file);
  const stored = cursors.files[file] || cursors.files[aliases[0]] || {};
  // A compressed session is skipped until it changes; decompressing it again would only re-read the same bytes.
  const stat = isCompressedSession(file) ? (({ size, mtimeMs }) => ({ size, mtimeMs }))(fs.statSync(file)) : undefined;
  if (stat && cursors.files[file] && stored.parserVersion === SESSION_PARSER_VERSION &&
      JSON.stringify(stored.stat) === JSON.stringify(stat) && !fs.existsSync(quarantineFile(cfg, file))) {
    return { changed: 0, failures: 0 };
  }
  // A moved transcript may not be byte-identical at the old offset, so its successor always replays.
  const restart = stored.parserVersion !== SESSION_PARSER_VERSION || (!!source.predecessor && !cursors.files[file]);
  const replay = Object.hasOwn(stored, 'parserVersion') && restart;
  let state = copyJson(restart ? {} : (stored.state || {}));
  const sessionIds = new Set(restart ? [] : (stored.sessionIds || []));
  const replayEvents = [];
  // Codex threads of one session share its session id, and a spawned thread copies its parent's history
  // cut at the fork point. A Codex replay therefore replaces only the turns this file emits again.
  // ponytail: stale Codex turns a newer parser no longer emits are kept; add source-file provenance to events if they matter.
  const replayTurnIds = replay && source.provider === 'codex' ? new Set() : undefined;
  let changed = 0;
  let failure;
  const parseRecord = parserFor(source.provider);
  const start = restart ? 0 : (stored.offset || 0);
  const offset = await readJsonLines(file, start, async (line, lineStart) => {
    const before = copyJson(state);
    let record;
    try {
      record = JSON.parse(line);
      const parsed = parseRecord(record, state);
      state = parsed.state;
      if (state.sessionId) sessionIds.add(state.sessionId);
      for (const turn of parsed.events) {
        if (turn.sessionId) sessionIds.add(turn.sessionId);
        const event = normalizedSessionEvent(cfg, turn);
        if (replay) replayEvents.push(event);
        else if (upsertEventRecord(cfg, event)) changed += 1;
      }
      return true;
    } catch (err) {
      state = before;
      failure = {
        provider: source.provider,
        pathHash: crypto.createHash('sha256').update(file).digest('hex'),
        offset: lineStart,
        affectedDate: affectedDate(cfg, state, file),
        parserVersion: SESSION_PARSER_VERSION,
        schemaSignature: schemaSignature(record),
        code: err.code || (err instanceof SyntaxError ? 'invalid_json' : 'session_ingest_error'),
      };
      return false;
    }
  }).catch(err => {
    // An unreadable compressed file is quarantined like a parse failure instead of aborting the run.
    if (!isCompressedSession(file)) throw err;
    failure = {
      provider: source.provider,
      pathHash: crypto.createHash('sha256').update(file).digest('hex'),
      offset: start,
      affectedDate: affectedDate(cfg, state, file),
      parserVersion: SESSION_PARSER_VERSION,
      schemaSignature: 'unreadable',
      code: 'session_read_error',
    };
    return start;
  });

  if (source.predecessor && failure) return recordSuccessorFailure(cfg, source, failure);
  // A retry's original turn was already emitted; re-emitting it as pending would downgrade it.
  const pendingTurn = state.turn?.prompt ? state.turn : (state.turn?.continuation?.emitted ? undefined : state.turn?.continuation);
  if (pendingTurn) {
    const pending = { ...pendingTurn, provider: source.provider, status: 'pending' };
    if (pending.sessionId) sessionIds.add(pending.sessionId);
    const event = normalizedSessionEvent(cfg, pending);
    if (replay) replayEvents.push(event);
    else if (upsertEventRecord(cfg, event)) changed += 1;
  }
  if (replay && failure) {
    cursors.files[file] = stored;
  } else {
    if (replay) {
      for (const event of replayEvents) replayTurnIds?.add(event.turnId);
      changed += replaceLocalSessionEvents(cfg, source.provider, sessionIds, replayEvents, replayTurnIds);
    }
    cursors.files[file] = {
      provider: source.provider,
      offset,
      parserVersion: SESSION_PARSER_VERSION,
      state,
      sessionIds: [...sessionIds].sort(),
      ...(stat ? { stat } : {}),
    };
  }
  const quarantine = quarantineFile(cfg, file);
  const previousFailure = readJson(quarantine, null);
  if (failure) {
    writeJson(quarantine, failure);
    if (JSON.stringify(previousFailure) !== JSON.stringify(failure)) {
      writeInternalLog(cfg, 'session_ingest_failed', failure);
    }
  } else if (fs.existsSync(quarantine)) {
    fs.unlinkSync(quarantine);
    writeInternalLog(cfg, 'session_ingest_recovered', {
      provider: source.provider,
      pathHash: previousFailure?.pathHash,
      affectedDate: previousFailure?.affectedDate,
      previousCode: previousFailure?.code,
      parserVersion: SESSION_PARSER_VERSION,
      changed,
    });
  }
  if (!failure) {
    for (const alias of aliases) {
      delete cursors.files[alias];
      const oldQuarantine = quarantineFile(cfg, alias);
      if (fs.existsSync(oldQuarantine)) fs.unlinkSync(oldQuarantine);
    }
    if (source.predecessor) {
      writeInternalLog(cfg, 'session_successor_attempted', { ...source.attempt, recovered: true, changed });
    }
  }
  return { changed, failures: failure ? 1 : 0 };
}

// The predecessor keeps its cursor and quarantine; the attempt is recorded so the same file is not re-read.
function recordSuccessorFailure(cfg, source, failure) {
  const target = quarantineFile(cfg, source.predecessor);
  const previous = readJson(target, {});
  writeJson(target, {
    ...failure,
    pathHash: previous.pathHash,
    affectedDate: previous.affectedDate || failure.affectedDate,
    successorAttempt: source.attempt.stat,
  });
  writeInternalLog(cfg, 'session_successor_attempted', { ...source.attempt, recovered: false, code: failure.code });
  return { changed: 0, failures: 1 };
}

// Codex compresses old rollouts to `.jsonl.zst` or moves them to archived_sessions; a quarantine on the
// old path would otherwise block forever because the old path is never read again.
function movedQuarantineSources(cfg, cursors) {
  const dir = path.join(sessionIngestDir(cfg), 'quarantine');
  if (!fs.existsSync(dir)) return [];
  const byHash = new Map(Object.keys(cursors).map(file => [crypto.createHash('sha256').update(file).digest('hex'), file]));
  const sources = [];
  for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.json'))) {
    const entry = readJson(path.join(dir, name), {});
    const predecessor = byHash.get(entry.pathHash);
    if (!predecessor || cursors[predecessor].provider !== 'codex' || fs.existsSync(predecessor)) continue;
    const successor = sessionSuccessor(predecessor);
    if (!successor) continue;
    const { size, mtimeMs } = fs.statSync(successor);
    const stat = { parserVersion: SESSION_PARSER_VERSION, size, mtimeMs };
    if (JSON.stringify(entry.successorAttempt) === JSON.stringify(stat)) continue;
    sources.push({
      provider: 'codex',
      path: canonicalSessionPath(successor),
      predecessor,
      attempt: { pathHash: entry.pathHash, affectedDate: entry.affectedDate, stat },
    });
  }
  return sources;
}

function quarantineCount(cfg) {
  const dir = path.join(sessionIngestDir(cfg), 'quarantine');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')).length : 0;
}

async function ingestSessionFilesUnlocked(cfg, sources, opts = {}) {
  const started = Date.now();
  withEventSpoolLock(cfg, () => {});
  const cursors = readJson(cursorFile(cfg), { version: 1, files: {} });
  cursors.version = SESSION_PARSER_VERSION;
  let changed = 0;
  let failures = 0;
  const all = opts.moved ? [...sources, ...movedQuarantineSources(cfg, cursors.files)] : sources;
  const unique = [...new Map(all.map(source => [canonicalSessionPath(source.path), source])).values()];
  for (const source of unique) {
    const result = await ingestSessionFile(cfg, source, cursors);
    changed += result.changed;
    failures += result.failures;
  }
  // A vanished transcript's stale cursor is never read again. Current-version cursors stay: publish
  // scopes read them. Quarantined ones stay: movedQuarantineSources maps them to their successor.
  for (const [file, cursor] of Object.entries(cursors.files)) {
    if (cursor.parserVersion !== SESSION_PARSER_VERSION && !fs.existsSync(file) &&
        !fs.existsSync(quarantineFile(cfg, file))) delete cursors.files[file];
  }
  writeJson(cursorFile(cfg), cursors);
  writeInternalLog(cfg, 'session_ingest_completed', {
    parserVersion: SESSION_PARSER_VERSION,
    files: unique.length,
    changed,
    failures,
    durationMs: Date.now() - started,
  });
  return opts.moved ? { changed, failures, remaining: quarantineCount(cfg) } : { changed, failures };
}

async function ingestSessionFiles(cfg, sources, opts = {}) {
  const lock = sessionIngestLockFile(cfg);
  if (!acquireLock(lock)) throw new Error('session ingestion already running');
  try {
    return await ingestSessionFilesUnlocked(cfg, sources, opts);
  } finally {
    releaseLock(lock);
  }
}

function hasSessionFailure(cfg, date) {
  const dir = path.join(sessionIngestDir(cfg), 'quarantine');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(name => readJson(path.join(dir, name), {}).affectedDate === date);
}

function hasAnySessionFailure(cfg) {
  const dir = path.join(sessionIngestDir(cfg), 'quarantine');
  try {
    return fs.readdirSync(dir).some(name => name.endsWith('.json'));
  } catch {
    return false;
  }
}

async function ingestKnownSessions(cfg, discover = false) {
  const known = readJson(sessionSourcesFile(cfg), []);
  const sources = discover ? [...known, ...discoverSessionSources()] : known;
  const unique = [...new Map(sources.map(source => {
    const file = canonicalSessionPath(source.path);
    // Codex compresses or archives finished rollouts; follow the move instead of dropping the source.
    const moved = source.provider === 'codex' && !fs.existsSync(file) ? sessionSuccessor(file) : undefined;
    const target = moved ? canonicalSessionPath(moved) : file;
    return [target, { ...source, path: target }];
  })).values()]
    .filter(source => fs.existsSync(source.path));
  writeJson(sessionSourcesFile(cfg), unique);
  const result = await ingestSessionFiles(cfg, unique, { moved: true });
  // Report every remaining quarantine, not only this run's parse failures: each one still blocks.
  return { changed: result.changed, failures: result.remaining };
}

module.exports = {
  hasAnySessionFailure,
  hasSessionFailure,
  ingestKnownSessions,
  ingestSessionFiles,
  normalizedSessionEvent,
};
