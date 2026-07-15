const assert = require('node:assert/strict');
const test = require('node:test');

const { chunkRawEvents } = require('../bin/report-chunks');

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    event: 'AISessionTurn',
    tsUtc: '2026-07-14T00:00:00.000Z',
    deviceId: 'device-a',
    provider: 'codex-transcript',
    sessionId: 'session-a',
    sourceId: 'source-a',
    cwd: '/repo',
    prompt: '질문',
    assistantResponse: '응답',
    ...overrides,
  };
}

function rawOf(events) {
  return events.map(value => JSON.stringify(value)).join('\n') + '\n';
}

function chunkLines(chunks) {
  return chunks.flatMap(chunk => chunk.raw.trimEnd().split('\n'));
}

test('keeps every UTF-8 JSONL record byte-for-byte without cutting content', () => {
  const raw = rawOf([
    event({ sourceId: 'one', prompt: '첫째 줄\n둘째 줄', assistantResponse: '한글 ✅' }),
    event({ sourceId: 'two', tsUtc: '2026-07-14T00:01:00.000Z', prompt: 'escaped \\n text' }),
    event({ sourceId: 'three', tsUtc: '2026-07-14T00:02:00.000Z', sessionId: 'session-b' }),
  ]);

  const chunks = chunkRawEvents(raw, { targetBytes: 512 });

  assert.deepEqual(chunkLines(chunks).sort(), raw.trimEnd().split('\n').sort());
  assert.equal(new Set(chunkLines(chunks)).size, 3);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.raw) === chunk.bytes));
});

test('keeps a complete session together when it fits the target', () => {
  const raw = rawOf([
    event({ sourceId: 'a1', sessionId: 'a', prompt: 'a'.repeat(100) }),
    event({ sourceId: 'b1', sessionId: 'b', prompt: 'b'.repeat(100) }),
    event({ sourceId: 'a2', sessionId: 'a', tsUtc: '2026-07-14T00:02:00.000Z', prompt: 'c'.repeat(100) }),
  ]);

  const chunks = chunkRawEvents(raw, { targetBytes: 800 });
  const sessionAChunks = chunks.filter(chunk => chunk.evidenceIds.some(id => id === 'a1' || id === 'a2'));

  assert.equal(sessionAChunks.length, 1);
  assert.deepEqual(sessionAChunks[0].evidenceIds.filter(id => id.startsWith('a')), ['a1', 'a2']);
});

test('splits an oversized session only between complete JSONL records', () => {
  const values = Array.from({ length: 8 }, (_, index) => event({
    sourceId: `part-${index}`,
    tsUtc: `2026-07-14T00:0${index}:00.000Z`,
    prompt: `문단-${index}-` + '가'.repeat(120),
  }));
  const raw = rawOf(values);

  const chunks = chunkRawEvents(raw, { targetBytes: 900 });

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunkLines(chunks), raw.trimEnd().split('\n'));
  assert.ok(chunks.every(chunk => chunk.bytes <= 900));
});

test('keeps one oversized atomic record intact as a soft-limit chunk', () => {
  const raw = rawOf([event({ sourceId: 'large', prompt: '원문'.repeat(2000) })]);
  const expectedLine = raw.trimEnd();

  const [chunk] = chunkRawEvents(raw, { targetBytes: 1024 });

  assert.equal(chunk.raw, expectedLine + '\n');
  assert.equal(chunk.bytes, Buffer.byteLength(raw));
  assert.ok(chunk.bytes > 1024);
});

test('preserves all records across an approximately 404 KiB input', () => {
  const values = Array.from({ length: 240 }, (_, index) => event({
    sourceId: `source-${index}`,
    sessionId: `session-${Math.floor(index / 6)}`,
    tsUtc: new Date(Date.UTC(2026, 6, 14, 0, index)).toISOString(),
    prompt: `작업 ${index} ` + '가나다라마바사'.repeat(70),
    assistantResponse: `결과 ${index} ` + 'ABCDEFG'.repeat(70),
  }));
  const raw = rawOf(values);
  assert.ok(Buffer.byteLength(raw) > 400 * 1024);

  const chunks = chunkRawEvents(raw, { targetBytes: 20 * 1024 });
  const originalLines = raw.trimEnd().split('\n');
  const outputLines = chunkLines(chunks);

  assert.deepEqual(outputLines, originalLines);
  assert.equal(new Set(chunks.map(chunk => chunk.chunkId)).size, chunks.length);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every(chunk => chunk.bytes <= 20 * 1024));
  assert.ok(chunks.every((chunk, index) => chunk.index === index && chunk.count === chunks.length));
});

test('rejects malformed raw JSONL with its line number', () => {
  assert.throws(
    () => chunkRawEvents(`${JSON.stringify(event())}\n{"broken":\n`),
    /invalid raw JSONL at line 2/,
  );
});

test('rejects non-object records and invalid target sizes', () => {
  assert.throws(() => chunkRawEvents('null\n'), /invalid raw JSONL event at line 1/);
  assert.throws(() => chunkRawEvents(rawOf([event()]), { targetBytes: 0 }), /positive integer/);
});

test('collects only string URLs from reference objects', () => {
  const [chunk] = chunkRawEvents(rawOf([event({
    references: [null, 'invalid', { url: 42 }, { url: 'https://example.com/allowed' }],
  })]));

  assert.deepEqual(chunk.referenceUrls, ['https://example.com/allowed']);
});
