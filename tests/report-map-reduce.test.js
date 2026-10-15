const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { chunkRawEvents } = require('../bin/report-chunks');
const {
  buildMapPrompt,
  mapRawEvidence,
  reduceMapSummaries,
  summaryBytes,
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

test('accepts a valid map summary larger than the former intermediate size cap', () => {
  const [chunk] = chunkRawEvents(rawEvents(1), { targetBytes: 4096 });
  const value = JSON.parse(summaryFor(chunk));
  value.tasks[0].background = ['가'.repeat(17 * 1024)];

  assert.doesNotThrow(() => validateMapSummary(JSON.stringify(value), chunk));
});

test('accepts a valid map summary wrapped in a Markdown JSON fence', () => {
  const [chunk] = chunkRawEvents(rawEvents(1), { targetBytes: 4096 });

  assert.doesNotThrow(() => validateMapSummary(`\`\`\`json\n${summaryFor(chunk)}\n\`\`\``, chunk));
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

test('retries only an invalid part with validation feedback', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-map-retry-'));
  const attempts = new Map();
  const prompts = new Map();

  const result = await mapRawEvidence({
    date: '2026-07-14',
    language: 'ko',
    raw: rawEvents(6),
    stateDir,
    targetBytes: 1800,
    async runPrompt(prompt, chunk) {
      const count = (attempts.get(chunk.index) || 0) + 1;
      attempts.set(chunk.index, count);
      prompts.set(chunk.index, [...(prompts.get(chunk.index) || []), prompt]);
      if (chunk.index === 1 && count < 3) return 'temporary invalid output';
      return summaryFor(chunk);
    },
  });

  assert.equal(attempts.get(1), 3);
  assert.match(prompts.get(1)[1], /Previous output failed validation: map summary is invalid JSON/);
  assert.ok([...attempts].every(([index, count]) => count === (index === 1 ? 3 : 1)));
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

test('reduces validated summaries in bounded batches without dropping evidence IDs', async () => {
  const chunks = chunkRawEvents(rawEvents(8), { targetBytes: 1800 });
  const summaries = chunks.map(chunk => JSON.parse(summaryFor(chunk)));
  const calls = [];
  const reduced = await reduceMapSummaries({
    date: '2026-07-14',
    language: 'ko',
    summaries,
    targetBytes: 700,
    async runPrompt(prompt, chunk) {
      calls.push({ prompt, chunk });
      return JSON.stringify({
        schemaVersion: 1,
        chunkId: chunk.chunkId,
        tasks: [{
          title: `병합 ${chunk.index}`,
          background: [],
          process: [],
          decisions: [],
          results: [],
          followUps: [],
          evidenceIds: chunk.evidenceIds,
          references: [],
        }],
      });
    },
  });

  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => call.prompt.includes('retain every supplied evidence ID')));
  assert.ok(summaryBytes(reduced) <= 700);
  assert.deepEqual(
    [...new Set(reduced.flatMap(summary => summary.tasks.flatMap(task => task.evidenceIds)))].sort(),
    chunks.flatMap(chunk => chunk.evidenceIds).sort(),
  );
});

test('recompresses an oversized atomic summary', async () => {
  const [chunk] = chunkRawEvents(rawEvents(1), { targetBytes: 4096 });
  const summary = JSON.parse(summaryFor(chunk));
  summary.tasks[0].background = ['가'.repeat(1000)];

  const reduced = await reduceMapSummaries({
    date: '2026-07-14',
    summaries: [summary],
    targetBytes: 1000,
    async runPrompt(prompt, intermediateChunk) {
      assert.match(prompt, /Keep the returned UTF-8 JSON under 1000 bytes/);
      return summaryFor(intermediateChunk);
    },
  });

  assert.ok(summaryBytes(reduced) <= 1000);
  assert.deepEqual(reduced[0].tasks[0].evidenceIds, chunk.evidenceIds);
});

test('converges when the model compresses only as far as each requested budget', async () => {
  const chunks = chunkRawEvents(rawEvents(24), { targetBytes: 1800 });
  const summaries = chunks.map(chunk => {
    const value = JSON.parse(summaryFor(chunk));
    value.tasks[0].background = ['가'.repeat(150)];
    return value;
  });
  const budgets = [];
  const reduced = await reduceMapSummaries({
    date: '2026-07-14',
    summaries,
    targetBytes: 1500,
    // Returns the input unchanged when it already fits, otherwise merges and pads to just under the budget.
    async runPrompt(_prompt, chunk) {
      budgets.push(chunk.maxOutputBytes);
      const inputs = chunk.raw.trim().split('\n').map(JSON.parse);
      if (inputs.length === 1 && chunk.bytes - 1 < chunk.maxOutputBytes) return JSON.stringify({ ...inputs[0], chunkId: chunk.chunkId });
      const value = {
        schemaVersion: 1,
        chunkId: chunk.chunkId,
        tasks: [{
          title: '병합', background: [''], process: [], decisions: [], results: [], followUps: [],
          evidenceIds: chunk.evidenceIds, references: [],
        }],
      };
      const room = chunk.maxOutputBytes - 1 - Buffer.byteLength(JSON.stringify(value));
      value.tasks[0].background = ['가'.repeat(Math.max(0, Math.floor(room / 3)))];
      return JSON.stringify(value);
    },
  });

  assert.ok(summaryBytes(reduced) <= 1500);
  assert.deepEqual(
    [...new Set(reduced.flatMap(summary => summary.tasks.flatMap(task => task.evidenceIds)))].sort(),
    chunks.flatMap(chunk => chunk.evidenceIds).sort(),
  );
});

test('fails before any model call when evidence IDs alone exceed the reduction target', async () => {
  const chunks = chunkRawEvents(rawEvents(12), { targetBytes: 1800 });
  const summaries = chunks.map(chunk => JSON.parse(summaryFor(chunk)));
  const floor = Buffer.byteLength(JSON.stringify({ evidenceIds: chunks.flatMap(chunk => chunk.evidenceIds), references: [] }));
  let calls = 0;
  await assert.rejects(
    reduceMapSummaries({ date: '2026-07-14', summaries, targetBytes: floor, async runPrompt() { calls += 1; } }),
    /evidence IDs exceed the reduction target/,
  );
  assert.equal(calls, 0);
});

test('stops within the round limit when the model never meets a budget that would converge', async () => {
  const chunks = chunkRawEvents(rawEvents(24), { targetBytes: 1800 });
  const summaries = chunks.map(chunk => JSON.parse(summaryFor(chunk)));
  let calls = 0;
  await assert.rejects(
    reduceMapSummaries({
      date: '2026-07-14',
      summaries,
      targetBytes: 2600,
      // Keeps every evidence ID once per input summary, so outputs stay just above the floor of their inputs.
      async runPrompt(_prompt, chunk) {
        calls += 1;
        const inputs = chunk.raw.trim().split('\n').map(JSON.parse);
        return JSON.stringify({ schemaVersion: 1, chunkId: chunk.chunkId, tasks: inputs.flatMap(input => input.tasks) });
      },
    }),
    /did not (converge|shrink)|map summary must be under/,
  );
  assert.ok(calls <= (summaries.length + 2) * summaries.length * 3);
});

test('keeps the halving bound when a summary sits exactly at half the target', async () => {
  const chunks = chunkRawEvents(rawEvents(16), { targetBytes: 1800 });
  const target = 6000;
  const summaries = chunks.map(chunk => {
    const value = JSON.parse(summaryFor(chunk));
    value.tasks[0].background = [''];
    value.tasks[0].background = ['x'.repeat(target / 2 - Buffer.byteLength(JSON.stringify(value)))];
    return value;
  });
  assert.equal(Buffer.byteLength(JSON.stringify(summaries[0])), target / 2);
  let firstCalls = 0;
  const reduced = await reduceMapSummaries({
    date: '2026-07-14',
    summaries,
    targetBytes: target,
    async runPrompt(_prompt, chunk) {
      if (chunk.index === 0) firstCalls += 1;
      const value = {
        schemaVersion: 1, chunkId: chunk.chunkId,
        tasks: [{ title: 'm', background: [''], process: [], decisions: [], results: [], followUps: [], evidenceIds: chunk.evidenceIds, references: [] }],
      };
      value.tasks[0].background = ['x'.repeat(Math.max(0, chunk.maxOutputBytes - 1 - Buffer.byteLength(JSON.stringify(value))))];
      return JSON.stringify(value);
    },
  });
  assert.ok(summaryBytes(reduced) <= target);
  assert.ok(firstCalls <= Math.ceil(Math.log2(summaries.length)) + 2);
});

test('budgets room for every kept reference when references dominate a group', async () => {
  const chunks = chunkRawEvents(rawEvents(8), { targetBytes: 1800 });
  const urls = Array.from({ length: 60 }, (_, index) => `https://example.com/reference/${index}`);
  const summaries = chunks.map((chunk, index) => {
    const value = JSON.parse(summaryFor(chunk));
    value.tasks[0].background = ['가'.repeat(400)];
    value.tasks[0].references = (index === 0 ? urls : []).map(url => ({ url, title: '', evidenceIds: chunk.evidenceIds.slice(0, 1) }));
    return value;
  });
  const reduced = await reduceMapSummaries({
    date: '2026-07-14',
    summaries,
    targetBytes: 6000,
    async runPrompt(_prompt, chunk) {
      const inputs = chunk.raw.trim().split('\n').map(JSON.parse);
      return JSON.stringify({
        schemaVersion: 1,
        chunkId: chunk.chunkId,
        tasks: [{
          title: 'm', background: [], process: [], decisions: [], results: [], followUps: [],
          evidenceIds: chunk.evidenceIds,
          references: inputs.flatMap(input => input.tasks.flatMap(task => task.references))
            .map(reference => ({ url: reference.url, evidenceIds: reference.evidenceIds })),
        }],
      });
    },
  });
  assert.ok(summaryBytes(reduced) <= 6000);
  assert.equal(new Set(reduced.flatMap(summary => summary.tasks.flatMap(task => task.references.map(reference => reference.url)))).size, 60);
});

test('does not fail fast because of optional references when evidence IDs alone fit', async () => {
  const chunks = chunkRawEvents(rawEvents(8), { targetBytes: 1800 });
  const urls = Array.from({ length: 200 }, (_, index) => `https://example.com/reference/${index}`);
  const summaries = chunks.map((chunk, index) => {
    const value = JSON.parse(summaryFor(chunk));
    value.tasks[0].references = (index === 0 ? urls : []).map(url => ({ url, evidenceIds: chunk.evidenceIds.slice(0, 1) }));
    return value;
  });
  const reduced = await reduceMapSummaries({
    date: '2026-07-14',
    summaries,
    targetBytes: 3000,
    async runPrompt(_prompt, chunk) {
      return JSON.stringify({
        schemaVersion: 1, chunkId: chunk.chunkId,
        tasks: [{ title: 'm', background: [], process: [], decisions: [], results: [], followUps: [], evidenceIds: chunk.evidenceIds, references: [] }],
      });
    },
  });
  assert.ok(summaryBytes(reduced) <= 3000);
});

test('fails within the linear round cap when a reference-heavy group cannot shrink further', async () => {
  const longId = 'b'.repeat(200);
  const summary = (id, background, urls) => ({
    schemaVersion: 1, chunkId: `sha256:${id.slice(0, 8)}`,
    tasks: [{ title: 't', background: [background], process: [], decisions: [], results: [], followUps: [],
      evidenceIds: [id], references: urls.map(url => ({ url, evidenceIds: [id] })) }],
  });
  const urls = Array.from({ length: 100 }, (_, index) => `https://example.com/r/${index}`);
  const summaries = [summary('a', 'x'.repeat(30000), []), summary(longId, 'y'.repeat(9000), urls)];
  let calls = 0;
  // Keeps every reference and shrinks only to the budget, so the reference-heavy group stays above half the target.
  await assert.rejects(reduceMapSummaries({
    date: '2026-07-14', summaries, targetBytes: 40000,
    async runPrompt(_prompt, chunk) {
      calls += 1;
      const inputs = chunk.raw.trim().split('\n').map(JSON.parse);
      const value = { schemaVersion: 1, chunkId: chunk.chunkId, tasks: inputs.flatMap(input => input.tasks)
        .map(task => ({ ...task, background: [''] })) };
      value.tasks[0].background = ['z'.repeat(Math.max(0, chunk.maxOutputBytes - 1 - Buffer.byteLength(JSON.stringify(value))))];
      return JSON.stringify(value);
    },
  }), /did not converge within 4 reduction rounds/);
  assert.ok(calls <= 4 * 2);
});

test('rejects intermediate summaries that exceed the shrinking output limit', async () => {
  const chunks = chunkRawEvents(rawEvents(8), { targetBytes: 1800 });
  const summaries = chunks.map(chunk => JSON.parse(summaryFor(chunk)));

  await assert.rejects(
    reduceMapSummaries({
      date: '2026-07-14',
      summaries,
      targetBytes: 700,
      async runPrompt(_prompt, chunk) {
        const value = JSON.parse(summaryFor(chunk));
        value.tasks[0].background = ['가'.repeat(4096)];
        return JSON.stringify(value);
      },
    }),
    /map summary must be under/,
  );
});
