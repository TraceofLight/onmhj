'use strict';

// Conversation turns: ordering, local wall-clock time, and evidence rendering.

const { clip } = require('../report-util');

// Local wall-clock time as YYYY-MM-DDTHH:MM:SS so reports never mix UTC and local times.
function localTime(tsUtc, timeZone) {
  const date = new Date(tsUtc);
  if (!tsUtc || Number.isNaN(date.getTime())) return String(tsUtc || '');
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(date).replace(' ', 'T');
  } catch {
    return String(tsUtc);
  }
}

function buildTurns(records) {
  return records
    .filter(record => record && (record.prompt || record.assistantResponse))
    .sort((a, b) => String(a.tsUtc || '').localeCompare(String(b.tsUtc || '')))
    .map((record, i) => ({
      key: `t${i + 1}`,
      id: record.sourceId || `turn-${i + 1}`,
      session: record.sessionId || record.sourceId || `turn-${i + 1}`,
      time: localTime(record.tsUtc, record.timeZone),
      prompt: String(record.prompt || ''),
      answer: String(record.assistantResponse || ''),
      references: Array.isArray(record.references) ? record.references : [],
    }));
}

// Turn keys are shown only where the model must cite them (extraction); elsewhere they would leak into report text.
function renderTurn(turn, answerChars = Infinity, showKey = true) {
  return `[${showKey ? `${turn.key} ` : ''}${turn.time.replace('T', ' ').slice(0, 16)}] 세션 ${turn.session.slice(-8)}\n요청: ${turn.prompt}\n최종 답변: ${clip(turn.answer, answerChars)}`;
}

module.exports = {
  buildTurns,
  renderTurn,
};
