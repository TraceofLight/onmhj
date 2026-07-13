const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const onmhj = require('../bin/onmhj');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-sessions-'));
}

function cfg(stateDir) {
  return { stateDir, timeZone: 'UTC', deviceId: 'test-device' };
}

function readEvents(stateDir, date = '2026-07-13') {
  const file = path.join(stateDir, 'events', `${date}.jsonl`);
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
}

test('completed source event replaces pending local event', () => {
  const stateDir = tempDir();
  const base = {
    schemaVersion: 1,
    event: 'AISessionTurn',
    source: 'codex-transcript',
    sourceId: 'codex:session:turn',
    provider: 'codex',
    sessionId: 'session',
    turnId: 'turn',
    tsUtc: '2026-07-13T01:00:00.000Z',
    localDate: '2026-07-13',
    cwd: 'D:\\work\\repo',
    prompt: 'task',
  };

  assert.equal(onmhj.upsertEventRecord(cfg(stateDir), { ...base, status: 'pending' }), true);
  assert.equal(onmhj.upsertEventRecord(cfg(stateDir), {
    ...base,
    assistantResponse: 'done',
    status: 'complete',
  }), true);

  const events = readEvents(stateDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'complete');
  assert.equal(events[0].assistantResponse, 'done');
});

test('merge uses latest sourceId and removes only superseded prompt previews', () => {
  const stored = [{
    event: 'UserPromptSubmit',
    sessionId: 'session-1',
    tsUtc: '2026-07-13T00:00:00.000Z',
    promptPreview: 'ambient preview',
  }, {
    event: 'AISessionTurn',
    sourceId: 'codex:session-1:turn-1',
    sessionId: 'session-1',
    tsUtc: '2026-07-13T00:00:01.000Z',
    prompt: 'real task',
    status: 'pending',
  }, {
    event: 'GitCommit',
    sourceId: 'git:1',
    tsUtc: '2026-07-13T00:00:02.000Z',
  }];
  const local = [{
    event: 'AISessionTurn',
    sourceId: 'codex:session-1:turn-1',
    sessionId: 'session-1',
    tsUtc: '2026-07-13T00:00:01.000Z',
    prompt: 'real task',
    assistantResponse: 'final answer',
    status: 'complete',
  }, {
    event: 'UserPromptSubmit',
    sessionId: 'session-2',
    tsUtc: '2026-07-13T00:00:03.000Z',
    promptPreview: 'keep me',
  }, {
    event: 'ManualImport',
    sourceId: 'manual:1',
    tsUtc: '2026-07-13T00:00:04.000Z',
  }];

  const merged = onmhj.mergeEvents(stored, local);

  assert.equal(merged.find(event => event.sourceId === 'codex:session-1:turn-1').status, 'complete');
  assert.equal(merged.some(event => event.event === 'UserPromptSubmit' && event.sessionId === 'session-1'), false);
  assert.equal(merged.some(event => event.event === 'UserPromptSubmit' && event.sessionId === 'session-2'), true);
  assert.equal(merged.some(event => event.event === 'GitCommit'), true);
  assert.equal(merged.some(event => event.event === 'ManualImport'), true);
});

test('assistant responses are redacted during merge', () => {
  const [event] = onmhj.mergeEvents([{
    event: 'AISessionTurn',
    sourceId: 'turn:1',
    tsUtc: '2026-07-13T00:00:00.000Z',
    assistantResponse: 'token=super-secret-value',
  }]);

  assert.equal(event.assistantResponse.includes('super-secret-value'), false);
  assert.match(event.assistantResponse, /\[REDACTED\]/);
});
