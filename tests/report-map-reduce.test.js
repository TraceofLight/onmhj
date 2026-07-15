const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { chunkRawEvents } = require('../bin/report-chunks');
const {
  buildMapPrompt,
  mapRawEvidence,
  validateMapSummary,
} = require('../bin/report-map-reduce');

function rawEvents(count = 12) {
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    event: 'AISessionTurn',
    sourceId: `source-${index}`,
    deviceId: 'device',
    provider: 'codex',
    sessionId: `session-${index}`,
    tsUtc: new Date(Date.UTC(2026, 6, 14, 0, index)).toISOString(),
    prompt: `작업 ${index} ` + '가'.repeat(300),
    assistantResponse: `결과 ${index} ` + '나'.repeat(300),
  })).join('\n') + '\n';
}

function summaryFor(chunk) {
  return JSON.stringify({
    schemaVersion: 1,
    chunkId: chunk.chunkId,
    tasks: [{
      title: `청크 ${chunk.index}`,
      background: ['확인된 배경'],
      process: ['확인된 과정'],
      decisions: [],
      results: ['확인된 결과'],
      followUps: [],
      evidenceIds: chunk.evidenceIds,
      references: [],
    }],
  });
}

test('map prompt contains only its chunk and strict JSON instructions', () => {
  const [chunk] = chunkRawEvents(rawEvents(1), { targetBytes: 4096 });
  const prompt = buildMapPrompt('2026-07-14', 'ko', chunk);

  assert.match(prompt, /2026-07-14/);
  assert.match(prompt, new RegExp(chunk.chunkId.replace(':', '\\:')));
  assert.match(prompt, /JSON/);
  assert.match(prompt, /도구를 사용하지/);
  assert.match(prompt, /source-0/);
  assert.match(prompt, /작업 0/);
});

test('rejects map summaries that cite unknown evidence', () => {
  const [chunk] = chunkRawEvents(rawEvents(1), { targetBytes: 4096 });
  const value = JSON.parse(summaryFor(chunk));
  value.tasks[0].evidenceIds = ['invented'];

  assert.throws(() => validateMapSummary(JSON.stringify(value), chunk), /unknown evidence/);
});

test('rejects map summaries that omit supplied evidence', () => {
  const [chunk] = chunkRawEvents(rawEvents(2), { targetBytes: 4096 });
  const value = JSON.parse(summaryFor(chunk));
  value.tasks[0].evidenceIds = [chunk.evidenceIds[0]];

  assert.equal(chunk.evidenceIds.length, 2);
  assert.throws(() => validateMapSummary(JSON.stringify(value), chunk), /omits evidence/);
});

test('rejects map references that were not collected in the raw chunk', () => {
  const raw = JSON.stringify({
    event: 'AISessionTurn',
    sourceId: 'source-reference',
    references: [{ url: 'https://example.com/allowed', title: '허용 자료' }],
  }) + '\n';
  const [chunk] = chunkRawEvents(raw, { targetBytes: 4096 });
  const value = JSON.parse(summaryFor(chunk));
  value.tasks[0].references = [{
    url: 'https://example.com/invented',
    title: '추가 자료',
    evidenceIds: ['source-reference'],
  }];

  assert.throws(() => validateMapSummary(JSON.stringify(value), chunk), /unsupported reference/);
});

test('runs no more than three map subagents concurrently', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-map-'));
  const raw = rawEvents(12);
  let active = 0;
  let maximum = 0;

  const result = await mapRawEvidence({
    date: '2026-07-14',
    language: 'ko',
    raw,
    stateDir,
    targetBytes: 1800,
    async runPrompt(_prompt, chunk) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return summaryFor(chunk);
    },
  });

  assert.ok(result.chunks.length > 3);
  assert.equal(maximum, 3);
  assert.equal(result.summaries.length, result.chunks.length);
});

test('reuses valid cached parts and regenerates only a corrupt part', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-map-cache-'));
  const options = {
    date: '2026-07-14',
    language: 'ko',
    raw: rawEvents(6),
    stateDir,
    targetBytes: 1800,
  };
  let calls = 0;
  const runPrompt = async (_prompt, chunk) => {
    calls += 1;
    return summaryFor(chunk);
  };

  const first = await mapRawEvidence({ ...options, runPrompt });
  assert.equal(calls, first.chunks.length);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(first.cacheDir, 'manifest.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(first.cacheDir, 'part-000.json')).mode & 0o777, 0o600);
  }

  calls = 0;
  const second = await mapRawEvidence({ ...options, runPrompt });
  assert.equal(calls, 0);
  assert.deepEqual(second.summaries, first.summaries);

  fs.writeFileSync(path.join(first.cacheDir, 'part-000.json'), '{broken');
  calls = 0;
  await mapRawEvidence({ ...options, runPrompt });
  assert.equal(calls, 1);
});

test('retries only a part whose first output fails validation', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-map-retry-'));
  const attempts = new Map();

  const result = await mapRawEvidence({
    date: '2026-07-14',
    language: 'ko',
    raw: rawEvents(6),
    stateDir,
    targetBytes: 1800,
    async runPrompt(_prompt, chunk) {
      const count = (attempts.get(chunk.index) || 0) + 1;
      attempts.set(chunk.index, count);
      if (chunk.index === 1 && count === 1) return 'temporary invalid output';
      return summaryFor(chunk);
    },
  });

  assert.equal(attempts.get(1), 2);
  assert.ok([...attempts].every(([index, count]) => count === (index === 1 ? 2 : 1)));
  assert.equal(result.summaries.length, result.chunks.length);
});

test('changes the cache key when raw evidence changes', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-map-key-'));
  const runPrompt = async (_prompt, chunk) => summaryFor(chunk);
  const first = await mapRawEvidence({
    date: '2026-07-14', language: 'ko', raw: rawEvents(4), stateDir, targetBytes: 1800, runPrompt,
  });
  const second = await mapRawEvidence({
    date: '2026-07-14', language: 'ko', raw: rawEvents(5), stateDir, targetBytes: 1800, runPrompt,
  });

  assert.notEqual(first.cacheDir, second.cacheDir);
});
