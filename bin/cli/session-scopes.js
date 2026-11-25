const fs = require('fs');
const path = require('path');
const { isTranscriptSessionEvent, loadEvents } = require('./events');
const { cursorFile } = require('./paths');
const { SESSION_PARSER_VERSION } = require('./session-sources');
const { readJson } = require('./util');

function sessionScopeKey(deviceId, provider, sessionId) {
  return [deviceId, provider, sessionId].join('\0');
}

function reconciledSessionScopes(cfg) {
  const cursors = readJson(cursorFile(cfg), { files: {} });
  const scopes = new Set();
  for (const cursor of Object.values(cursors.files || {})) {
    if (cursor.parserVersion !== SESSION_PARSER_VERSION || !cursor.provider) continue;
    for (const sessionId of cursor.sessionIds || []) {
      if (sessionId) scopes.add(sessionScopeKey(cfg.deviceId, cursor.provider, sessionId));
    }
  }
  return scopes;
}

function isReconciledSessionEvent(event, scopes) {
  return isTranscriptSessionEvent(event) && scopes.has(sessionScopeKey(
    event.deviceId,
    event.provider,
    event.sessionId,
  ));
}

function rawDatesWithReconciledEvents(cfg, scopes) {
  if (!scopes.size) return [];
  const dir = path.join(cfg.repoPath, 'raw', 'ai-sessions');
  try {
    return fs.readdirSync(dir)
      .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .filter(file => loadEvents(path.join(dir, file)).some(event => isReconciledSessionEvent(event, scopes)))
      .map(file => file.slice(0, 10));
  } catch {
    return [];
  }
}

module.exports = {
  isReconciledSessionEvent,
  rawDatesWithReconciledEvents,
  reconciledSessionScopes,
};
