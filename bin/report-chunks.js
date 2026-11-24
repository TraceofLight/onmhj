const crypto = require('node:crypto');

const { segmentTurns } = require('./conversation-segments');

const DEFAULT_TARGET_BYTES = 20 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseRawRecords(raw) {
  const records = [];
  for (const [index, line] of String(raw || '').split('\n').entries()) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`invalid raw JSONL at line ${index + 1}`);
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`invalid raw JSONL event at line ${index + 1}`);
    }
    const evidenceId = typeof event.sourceId === 'string' && event.sourceId
      ? event.sourceId
      : `sha256:${sha256(line)}`;
    const sessionKey = event.sessionId
      ? [event.deviceId || '', event.provider || event.source || '', event.sessionId].join(':')
      : `event:${evidenceId}`;
    records.push({
      bytes: Buffer.byteLength(line) + 1,
      event,
      evidenceId,
      index,
      line,
      sessionKey,
      timestamp: String(event.tsUtc || event.ts || ''),
    });
  }
  return records;
}

function sessionGroups(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.sessionKey)) grouped.set(record.sessionKey, []);
    grouped.get(record.sessionKey).push(record);
  }
  return [...grouped.values()]
    .map(items => items.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.index - b.index))
    .sort((a, b) => a[0].timestamp.localeCompare(b[0].timestamp) || a[0].index - b[0].index);
}

// Uses a session's planned topic segments only when they cover its records exactly and in order.
function plannedSegments(group, segmentsBySession) {
  const planned = segmentsBySession && segmentsBySession[group[0].sessionKey];
  if (!Array.isArray(planned) || planned.length < 2) return null;
  const ids = planned.flat();
  if (ids.length !== group.length || ids.some((id, i) => id !== group[i].evidenceId)) return null;
  let offset = 0;
  return planned.map(segment => group.slice(offset, (offset += segment.length)));
}

// Asks the segment planner to split sessions larger than the chunk target at topic boundaries.
async function planRawSegments(raw, { targetBytes = DEFAULT_TARGET_BYTES, runPrompt, cache = null }) {
  const plans = {};
  for (const group of sessionGroups(parseRawRecords(raw))) {
    if (group[0].sessionKey.startsWith('event:')) continue;
    if (group.reduce((sum, record) => sum + record.bytes, 0) <= targetBytes) continue;
    const key = JSON.stringify({ targetBytes, lines: group.map(record => record.line) });
    const stored = cache && cache.read(key);
    if (stored) {
      if (stored.planned) plans[group[0].sessionKey] = stored.segments;
      continue;
    }
    const turns = group.map(record => ({
      id: record.evidenceId,
      bytes: record.bytes,
      time: record.timestamp.slice(11, 16),
      prompt: record.event.prompt,
      answer: record.event.assistantResponse,
    }));
    const result = await segmentTurns(turns, { budgetBytes: targetBytes, runPrompt });
    if (cache) cache.write(key, { planned: result.planned, segments: result.segments });
    if (result.planned) plans[group[0].sessionKey] = result.segments;
  }
  return plans;
}

function chunkRawEvents(raw, options = {}) {
  const targetBytes = options.targetBytes ?? DEFAULT_TARGET_BYTES;
  if (!Number.isInteger(targetBytes) || targetBytes < 1) throw new Error('targetBytes must be a positive integer');

  const groups = sessionGroups(parseRawRecords(raw));
  const packed = [];
  let current = [];
  let currentBytes = 0;
  const flush = () => {
    if (!current.length) return;
    packed.push(current);
    current = [];
    currentBytes = 0;
  };

  const pack = (group) => {
    const groupBytes = group.reduce((sum, record) => sum + record.bytes, 0);
    if (groupBytes <= targetBytes) {
      if (current.length && currentBytes + groupBytes > targetBytes) flush();
      current.push(...group);
      currentBytes += groupBytes;
      return;
    }

    flush();
    for (const record of group) {
      if (current.length && currentBytes + record.bytes > targetBytes) flush();
      current.push(record);
      currentBytes += record.bytes;
      if (currentBytes >= targetBytes) flush();
    }
  };

  for (const group of groups) {
    const segments = plannedSegments(group, options.segments);
    if (segments) segments.forEach(pack);
    else pack(group);
  }
  flush();

  const count = packed.length;
  return packed.map((records, index) => {
    const chunkRaw = records.map(record => record.line).join('\n') + '\n';
    return {
      bytes: Buffer.byteLength(chunkRaw),
      chunkId: `sha256:${sha256(chunkRaw)}`,
      count,
      evidenceIds: records.map(record => record.evidenceId),
      index,
      raw: chunkRaw,
      referenceUrls: [...new Set(records.flatMap(record => (
        Array.isArray(record.event.references)
          ? record.event.references.map(reference => reference && typeof reference === 'object' ? reference.url : '')
          : []
      )).filter(url => typeof url === 'string' && url))],
      sessionKeys: [...new Set(records.map(record => record.sessionKey))],
    };
  });
}

module.exports = {
  DEFAULT_TARGET_BYTES,
  chunkRawEvents,
  parseRawRecords,
  planRawSegments,
};
