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
  return { stateDir, timeZone: 'UTC', deviceId: 'test-device', promptMode: 'full' };
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

test('session ingestion advances its cursor once and does not duplicate events', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'codex.jsonl');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'codex-transcript.jsonl'), transcript);

  const first = await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'codex', path: transcript }]);
  const second = await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'codex', path: transcript }]);

  assert.deepEqual(first, { changed: 1, failures: 0 });
  assert.deepEqual(second, { changed: 0, failures: 0 });
  assert.equal(readEvents(stateDir).length, 1);
  const cursors = JSON.parse(fs.readFileSync(path.join(stateDir, 'session-ingest', 'cursors.json'), 'utf8'));
  assert.equal(cursors.files[path.resolve(transcript)].offset, fs.statSync(transcript).size);
});

test('pending turn is replaced after transcript completion is appended', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'codex.jsonl');
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-transcript.jsonl'), 'utf8').trim().split('\n');
  fs.writeFileSync(transcript, lines.slice(0, 4).join('\n') + '\n');

  await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'codex', path: transcript }]);
  assert.equal(readEvents(stateDir)[0].status, 'pending');

  fs.appendFileSync(transcript, lines.slice(4).join('\n') + '\n');
  await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'codex', path: transcript }]);
  const events = readEvents(stateDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'complete');
  assert.equal(events[0].assistantResponse, 'completed answer');
});

test('parse failure stops the cursor, stores metadata only, and clears after retry', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'codex.jsonl');
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-transcript.jsonl'), 'utf8').trim().split('\n');
  const prefix = lines.slice(0, 4).join('\n') + '\n';
  const rawSecret = 'token=must-not-enter-quarantine';
  fs.writeFileSync(transcript, prefix + `{broken:${rawSecret}}\n`);

  const failed = await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'codex', path: transcript }]);
  const cursorFile = path.join(stateDir, 'session-ingest', 'cursors.json');
  const failedCursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  const quarantineDir = path.join(stateDir, 'session-ingest', 'quarantine');
  const quarantineFile = path.join(quarantineDir, fs.readdirSync(quarantineDir)[0]);
  const quarantine = fs.readFileSync(quarantineFile, 'utf8');

  assert.deepEqual(failed, { changed: 1, failures: 1 });
  assert.equal(failedCursor.files[path.resolve(transcript)].offset, Buffer.byteLength(prefix));
  assert.equal(quarantine.includes(rawSecret), false);
  assert.equal(onmhj.hasSessionFailure(cfg(stateDir), '2026-07-13'), true);

  fs.writeFileSync(transcript, prefix + lines.slice(4).join('\n') + '\n');
  const retried = await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'codex', path: transcript }]);

  assert.deepEqual(retried, { changed: 1, failures: 0 });
  assert.equal(fs.readdirSync(quarantineDir).length, 0);
  assert.equal(onmhj.hasSessionFailure(cfg(stateDir), '2026-07-13'), false);
  assert.equal(readEvents(stateDir)[0].status, 'complete');
});
