const fs = require('fs');
const path = require('path');
const { sanitizeEvent } = require('./references');
const { readJsonFromString, utcDateKey } = require('./util');

function eventDedupeKey(event) {
  if (event.sourceId) return `sourceId:${event.sourceId}`;
  return [
    'event',
    event.tsUtc || event.ts || '',
    event.event || '',
    event.sessionId || '',
    event.deviceId || '',
    event.cwd || '',
    event.prompt || event.promptPreview || '',
  ].join(':');
}

// Transcripts only grow, so a pending copy of a completed turn comes from a truncated fork copy.
function isStatusDowngrade(existing, incoming) {
  return existing.status === 'complete' && incoming.status === 'pending';
}

function isTranscriptSessionEvent(event) {
  return event.event === 'AISessionTurn' &&
    event.source === `${event.provider}-transcript`;
}

function loadEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => readJsonFromString(line, null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mergeEvents(...groups) {
  const sourceIndexes = new Map();
  const seen = new Set();
  const merged = [];
  for (const event of groups.flat()) {
    const clean = sanitizeEvent(event);
    if (clean.sourceId) {
      if (sourceIndexes.has(clean.sourceId)) merged[sourceIndexes.get(clean.sourceId)] = clean;
      else {
        sourceIndexes.set(clean.sourceId, merged.length);
        merged.push(clean);
      }
      continue;
    }
    const key = eventDedupeKey(clean);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(clean);
  }
  const canonicalSessions = new Set(merged
    .filter(event => event.event === 'AISessionTurn' && event.sessionId)
    .map(event => event.sessionId));
  return merged
    .filter(event => !(event.event === 'UserPromptSubmit' && canonicalSessions.has(event.sessionId)))
    .sort((a, b) => String(a.tsUtc || a.ts).localeCompare(String(b.tsUtc || b.ts)));
}

function loadEventsForLocalDate(cfg, date) {
  const dir = path.join(cfg.stateDir, 'events');
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .map(file => path.join(dir, file));
  } catch {
    return [];
  }
  return files
    .flatMap(loadEvents)
    .filter(event => event.localDate === date || (!event.localDate && utcDateKey(new Date(event.ts)) === date))
    .map(sanitizeEvent)
    .sort((a, b) => String(a.tsUtc || a.ts).localeCompare(String(b.tsUtc || b.ts)));
}

module.exports = {
  eventDedupeKey,
  isStatusDowngrade,
  isTranscriptSessionEvent,
  loadEvents,
  loadEventsForLocalDate,
  mergeEvents,
};
