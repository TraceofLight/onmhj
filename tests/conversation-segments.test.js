const assert = require('node:assert/strict');
const test = require('node:test');

const { greedySplit, parseBoundaries, segmentTurns, segmentsFromBoundaries } = require('../bin/conversation-segments');
const { chunkRawEvents, planRawSegments } = require('../bin/report-chunks');

const turns = [10, 10, 10, 10, 10].map((bytes, i) => ({ id: `t${i}`, bytes, prompt: `질문 ${i}`, answer: `답 ${i}` }));

test('splits at the planned topic boundaries', async () => {
  let prompt;
  const result = await segmentTurns(turns, {
    budgetBytes: 30,
    runPrompt: async value => {
      prompt = value;
      return '{"boundaries":[2]}';
    },
  });
  assert.deepEqual(result.segments, [['t0', 't1'], ['t2', 't3', 't4']]);
  assert.equal(result.planned, true);
  assert.match(prompt, /누적 50B/);
});

test('repairs oversized planned segments by bytes', () => {
  assert.deepEqual(
    segmentsFromBoundaries(turns, [1], 20).map(segment => segment.map(turn => turn.id)),
    [['t0'], ['t1', 't2'], ['t3', 't4']],
  );
});

test('falls back to byte packing after two invalid plans', async () => {
  let calls = 0;
  const result = await segmentTurns(turns, {
    budgetBytes: 20,
    runPrompt: async () => {
      calls++;
      return calls === 1 ? 'no json' : '{"boundaries":[3,2]}';
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.planned, false);
  assert.deepEqual(result.segments, greedySplit(turns, 20).map(segment => segment.map(turn => turn.id)));
  assert.match(result.error, /ascending/);
});

test('does not plan sessions that already fit the budget', async () => {
  const result = await segmentTurns(turns, { budgetBytes: 100, runPrompt: async () => assert.fail('must not call') });
  assert.equal(result.planned, false);
  assert.equal(result.segments.length, 1);
});

test('rejects boundaries outside the turn range', () => {
  assert.throws(() => parseBoundaries('{"boundaries":[0]}', 5), /ascending/);
  assert.throws(() => parseBoundaries('{"boundaries":[5]}', 5), /ascending/);
  assert.deepEqual(parseBoundaries('계획: {"boundaries":[1,4]}', 5), [1, 4]);
});

function rawLines(count, padding) {
  return Array.from({ length: count }, (_, i) => JSON.stringify({
    event: 'AISessionTurn',
    deviceId: 'd',
    provider: 'dsh',
    sessionId: 's',
    sourceId: `id-${i}`,
    tsUtc: `2026-11-22T00:0${i}:00.000Z`,
    prompt: `질문 ${i}`,
    assistantResponse: 'x'.repeat(padding),
  })).join('\n') + '\n';
}

test('chunks a large session along planned segments and ignores mismatched plans', async () => {
  const raw = rawLines(4, 100);
  const targetBytes = 850;
  const segments = await planRawSegments(raw, { targetBytes, runPrompt: async () => '{"boundaries":[1]}' });
  assert.deepEqual(Object.values(segments), [[['id-0'], ['id-1', 'id-2', 'id-3']]]);

  const planned = chunkRawEvents(raw, { targetBytes, segments });
  assert.deepEqual(planned.map(chunk => chunk.evidenceIds), [['id-0'], ['id-1', 'id-2', 'id-3']]);
  assert.deepEqual(chunkRawEvents(raw, { targetBytes }).map(chunk => chunk.evidenceIds), [['id-0', 'id-1', 'id-2'], ['id-3']]);

  const mismatched = chunkRawEvents(raw, { targetBytes, segments: { 'd:dsh:s': [['id-1'], ['id-0', 'id-2', 'id-3']] } });
  assert.deepEqual(mismatched.map(chunk => chunk.evidenceIds), [['id-0', 'id-1', 'id-2'], ['id-3']]);
});
