const crypto = require('node:crypto');

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
    const evidenceId = event.sourceId || `sha256:${sha256(line)}`;
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

function chunkRawEvents(raw, options = {}) {
  const targetBytes = options.targetBytes || DEFAULT_TARGET_BYTES;
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

  for (const group of groups) {
    const groupBytes = group.reduce((sum, record) => sum + record.bytes, 0);
    if (groupBytes <= targetBytes) {
      if (current.length && currentBytes + groupBytes > targetBytes) flush();
      current.push(...group);
      currentBytes += groupBytes;
      continue;
    }

    flush();
    for (const record of group) {
      if (current.length && currentBytes + record.bytes > targetBytes) flush();
      current.push(record);
      currentBytes += record.bytes;
      if (currentBytes >= targetBytes) flush();
    }
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
      sessionKeys: [...new Set(records.map(record => record.sessionKey))],
    };
  });
}

module.exports = {
  DEFAULT_TARGET_BYTES,
  chunkRawEvents,
  parseRawRecords,
};
