const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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

function git(repo, args) {
  return childProcess.execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.com']);
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

test('legacy prompt modes cannot truncate canonical turns', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'codex.jsonl');
  const prompt = `task-${'p'.repeat(400)}`;
  const assistantResponse = `answer-${'a'.repeat(400)}`;
  fs.writeFileSync(transcript, [{
    type: 'session_meta',
    timestamp: '2026-07-13T01:00:00.000Z',
    payload: { session_id: 'lossless-session', cwd: 'D:\\work\\repo' },
  }, {
    type: 'event_msg',
    timestamp: '2026-07-13T01:00:01.000Z',
    payload: { type: 'task_started', turn_id: 'lossless-turn' },
  }, {
    type: 'event_msg',
    timestamp: '2026-07-13T01:00:02.000Z',
    payload: { type: 'user_message', message: prompt },
  }, {
    type: 'event_msg',
    timestamp: '2026-07-13T01:00:03.000Z',
    payload: { type: 'task_complete', last_agent_message: assistantResponse },
  }].map(JSON.stringify).join('\n') + '\n');

  await onmhj.ingestSessionFiles({ ...cfg(stateDir), promptMode: 'off' }, [{
    provider: 'codex',
    path: transcript,
  }]);

  const [event] = readEvents(stateDir);
  assert.equal(event.prompt, prompt);
  assert.equal(event.assistantResponse, assistantResponse);
  assert.equal(Object.hasOwn(event, 'promptPreview'), false);
  assert.equal(Object.hasOwn(event, 'assistantResponsePreview'), false);
});

test('a parser version change restarts stale cursor state', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'codex.jsonl');
  const records = [{
    type: 'event_msg',
    timestamp: '2026-07-13T01:00:00.000Z',
    payload: { type: 'task_started', turn_id: 'internal-context' },
  }, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<codex_internal_context>internal</codex_internal_context>' }],
    },
  }, {
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: 'internal result' },
  }];
  const lines = records.map(JSON.stringify);
  const prefix = lines.slice(0, 2).join('\n') + '\n';
  fs.writeFileSync(transcript, lines.join('\n') + '\n');

  const cursorFile = path.join(stateDir, 'session-ingest', 'cursors.json');
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({
    version: 1,
    files: {
      [path.resolve(transcript)]: {
        provider: 'codex',
        offset: Buffer.byteLength(prefix),
        parserVersion: 1,
        state: {
          turn: {
            sessionId: '',
            turnId: 'internal-context',
            tsUtc: '2026-07-13T01:00:00.000Z',
            cwd: '',
            prompt: '',
            assistantResponse: '',
          },
        },
      },
    },
  }));

  const result = await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'codex', path: transcript }]);
  const cursors = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));

  assert.deepEqual(result, { changed: 0, failures: 0 });
  assert.equal(cursors.files[path.resolve(transcript)].offset, fs.statSync(transcript).size);
  assert.equal(cursors.files[path.resolve(transcript)].parserVersion, 5);
});

test('a successful parser replay replaces stale local turns in its session scope', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'claude.jsonl');
  const records = [{
    type: 'user',
    sessionId: 'claude-replayed-session',
    uuid: 'real-turn',
    timestamp: '2026-07-13T02:00:00.000Z',
    cwd: 'D:\\work\\repo',
    message: { content: 'real human task' },
  }, {
    type: 'assistant',
    sessionId: 'claude-replayed-session',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'real final answer' }],
    },
  }];
  fs.writeFileSync(transcript, records.map(JSON.stringify).join('\n') + '\n');

  const eventDir = path.join(stateDir, 'events');
  fs.mkdirSync(eventDir, { recursive: true });
  const staleTranscript = {
    event: 'AISessionTurn',
    source: 'claude-transcript',
    sourceId: 'claude:claude-replayed-session:synthetic-turn',
    provider: 'claude',
    sessionId: 'claude-replayed-session',
    turnId: 'synthetic-turn',
    tsUtc: '2026-07-13T01:00:00.000Z',
    localDate: '2026-07-13',
    deviceId: 'test-device',
    prompt: 'Base directory for this skill: C:\\skill',
    status: 'complete',
  };
  const independentCapture = {
    ...staleTranscript,
    source: 'openai-capture',
    sourceId: 'openai:claude-replayed-session:independent-turn',
    turnId: 'independent-turn',
    prompt: 'independently captured task',
  };
  fs.writeFileSync(
    path.join(eventDir, '2026-07-13.jsonl'),
    [staleTranscript, independentCapture].map(event => JSON.stringify(event)).join('\n') + '\n',
  );

  const cursorFile = path.join(stateDir, 'session-ingest', 'cursors.json');
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({
    version: 4,
    files: {
      [path.resolve(transcript)]: {
        provider: 'claude',
        offset: fs.statSync(transcript).size,
        parserVersion: 4,
        state: {},
      },
    },
  }));

  const stagedModes = [];
  const writeFileSync = fs.writeFileSync;
  const renameSync = fs.renameSync;
  const replayLocks = [];
  fs.writeFileSync = (file, data, options) => {
    if (String(file).startsWith(eventDir + path.sep) && String(file).includes('.replay-')) {
      stagedModes.push(options && options.mode);
    }
    return writeFileSync(file, data, options);
  };
  fs.renameSync = (oldPath, newPath) => {
    if (String(oldPath).startsWith(eventDir + path.sep) && String(newPath).endsWith('.jsonl')) {
      replayLocks.push(fs.existsSync(path.join(stateDir, 'session-ingest', 'event-spool.lock')));
    }
    return renameSync(oldPath, newPath);
  };
  try {
    await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'claude', path: transcript }]);
  } finally {
    fs.writeFileSync = writeFileSync;
    fs.renameSync = renameSync;
  }

  const events = readEvents(stateDir);
  const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).files[path.resolve(transcript)];
  assert.deepEqual(events.map(event => event.sourceId).sort(), [
    'claude:claude-replayed-session:real-turn',
    'openai:claude-replayed-session:independent-turn',
  ]);
  assert.equal(events.find(event => event.sourceId.startsWith('claude:')).prompt, 'real human task');
  assert.ok(stagedModes.length > 0);
  assert.ok(stagedModes.every(mode => mode === 0o600));
  assert.ok(replayLocks.length > 0);
  assert.ok(replayLocks.every(Boolean));
  assert.equal(cursor.parserVersion, 5);
  assert.deepEqual(cursor.sessionIds, ['claude-replayed-session']);
});

test('a failed parser replay preserves the old canonical scope and remains replayable', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'claude.jsonl');
  fs.writeFileSync(transcript, '{broken json}\n');

  const staleEvent = {
    event: 'AISessionTurn',
    source: 'claude-transcript',
    sourceId: 'claude:claude-replayed-session:old-turn',
    provider: 'claude',
    sessionId: 'claude-replayed-session',
    turnId: 'old-turn',
    tsUtc: '2026-07-13T01:00:00.000Z',
    localDate: '2026-07-13',
    deviceId: 'test-device',
    prompt: 'previously collected task',
    status: 'complete',
  };
  const eventDir = path.join(stateDir, 'events');
  fs.mkdirSync(eventDir, { recursive: true });
  fs.writeFileSync(path.join(eventDir, '2026-07-13.jsonl'), JSON.stringify(staleEvent) + '\n');

  const cursorFile = path.join(stateDir, 'session-ingest', 'cursors.json');
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({
    version: 4,
    files: {
      [path.resolve(transcript)]: {
        provider: 'claude',
        offset: fs.statSync(transcript).size,
        parserVersion: 4,
        state: {},
      },
    },
  }));

  const result = await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'claude', path: transcript }]);

  const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).files[path.resolve(transcript)];
  assert.deepEqual(result, { changed: 0, failures: 1 });
  assert.deepEqual(readEvents(stateDir), [staleEvent]);
  assert.equal(cursor.parserVersion, 4);
  assert.equal(fs.readdirSync(path.join(stateDir, 'session-ingest', 'quarantine')).length, 1);
});

test('a replay storage failure rolls back the previous canonical scope', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'claude.jsonl');
  fs.writeFileSync(transcript, [{
    type: 'user',
    sessionId: 'rollback-session',
    uuid: 'new-turn',
    timestamp: '2026-07-13T02:00:00.000Z',
    message: { content: 'new task' },
  }, {
    type: 'assistant',
    sessionId: 'rollback-session',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'new answer' }] },
  }].map(JSON.stringify).join('\n') + '\n');

  const oldEvent = {
    event: 'AISessionTurn',
    source: 'claude-transcript',
    sourceId: 'claude:rollback-session:old-turn',
    provider: 'claude',
    sessionId: 'rollback-session',
    turnId: 'old-turn',
    tsUtc: '2026-07-13T01:00:00.000Z',
    localDate: '2026-07-13',
    deviceId: 'test-device',
    prompt: 'old task',
  };
  const eventDir = path.join(stateDir, 'events');
  fs.mkdirSync(eventDir, { recursive: true });
  fs.writeFileSync(path.join(eventDir, '2026-07-13.jsonl'), JSON.stringify(oldEvent) + '\n');

  const cursorFile = path.join(stateDir, 'session-ingest', 'cursors.json');
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({
    version: 4,
    files: {
      [path.resolve(transcript)]: {
        provider: 'claude',
        offset: fs.statSync(transcript).size,
        parserVersion: 4,
        state: {},
      },
    },
  }));

  const writeFileSync = fs.writeFileSync;
  const appendFileSync = fs.appendFileSync;
  const storageFailure = file => String(file).startsWith(eventDir + path.sep);
  fs.writeFileSync = (file, ...args) => {
    if (storageFailure(file)) throw new Error('injected replay storage failure');
    return writeFileSync(file, ...args);
  };
  fs.appendFileSync = (file, ...args) => {
    if (storageFailure(file)) throw new Error('injected replay storage failure');
    return appendFileSync(file, ...args);
  };
  try {
    await assert.rejects(
      () => onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'claude', path: transcript }]),
      /injected replay storage failure/,
    );
  } finally {
    fs.writeFileSync = writeFileSync;
    fs.appendFileSync = appendFileSync;
  }

  assert.deepEqual(readEvents(stateDir), [oldEvent]);
  const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).files[path.resolve(transcript)];
  assert.equal(cursor.parserVersion, 4);
});

test('a parser replay creates a missing private event directory', async () => {
  const stateDir = tempDir();
  const transcript = path.join(stateDir, 'claude.jsonl');
  fs.writeFileSync(transcript, [{
    type: 'user',
    sessionId: 'new-event-directory',
    uuid: 'new-turn',
    timestamp: '2026-07-13T02:00:00.000Z',
    message: { content: 'new task' },
  }, {
    type: 'assistant',
    sessionId: 'new-event-directory',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'new answer' }] },
  }].map(JSON.stringify).join('\n') + '\n');
  const cursorFile = path.join(stateDir, 'session-ingest', 'cursors.json');
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({
    version: 4,
    files: {
      [path.resolve(transcript)]: {
        provider: 'claude',
        offset: fs.statSync(transcript).size,
        parserVersion: 4,
        state: {},
      },
    },
  }));

  await onmhj.ingestSessionFiles(cfg(stateDir), [{ provider: 'claude', path: transcript }]);

  assert.equal(readEvents(stateDir).length, 1);
});

test('session ingestion recovers an interrupted replay transaction before parsing', async () => {
  const stateDir = tempDir();
  const eventDir = path.join(stateDir, 'events');
  const ingestDir = path.join(stateDir, 'session-ingest');
  fs.mkdirSync(eventDir, { recursive: true });
  fs.mkdirSync(ingestDir, { recursive: true });
  const target = path.join(eventDir, '2026-07-13.jsonl');
  const backup = path.join(eventDir, '.2026-07-13.jsonl.replay-backup');
  const temporary = path.join(eventDir, '.2026-07-13.jsonl.replay-next');
  const oldRaw = JSON.stringify({ sourceId: 'old-canonical' }) + '\n';
  fs.writeFileSync(target, JSON.stringify({ sourceId: 'partially-installed' }) + '\n');
  fs.writeFileSync(backup, oldRaw);
  fs.writeFileSync(temporary, JSON.stringify({ sourceId: 'staged-next' }) + '\n');
  fs.writeFileSync(path.join(ingestDir, 'replay-journal.json'), JSON.stringify({
    files: [{ target, backup, temporary, existed: true }],
  }));

  await onmhj.ingestSessionFiles(cfg(stateDir), []);

  assert.equal(fs.readFileSync(target, 'utf8'), oldRaw);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(path.join(ingestDir, 'replay-journal.json')), false);
});

test('an active ingestion lock prevents another process from recovering its journal', async () => {
  const stateDir = tempDir();
  const eventDir = path.join(stateDir, 'events');
  const ingestDir = path.join(stateDir, 'session-ingest');
  fs.mkdirSync(eventDir, { recursive: true });
  fs.mkdirSync(ingestDir, { recursive: true });
  const target = path.join(eventDir, '2026-07-13.jsonl');
  const journal = path.join(ingestDir, 'replay-journal.json');
  fs.writeFileSync(target, JSON.stringify({ sourceId: 'active-transaction' }) + '\n');
  fs.writeFileSync(journal, JSON.stringify({
    files: [{ target, backup: '', temporary: '', existed: false }],
  }));
  fs.writeFileSync(path.join(ingestDir, 'ingestion.lock'), JSON.stringify({
    pid: process.pid,
    ts: new Date().toISOString(),
  }));

  await assert.rejects(
    () => onmhj.ingestSessionFiles(cfg(stateDir), []),
    /session ingestion already running/,
  );

  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(journal), true);
});

test('an event writer waits for the replay spool lock instead of losing its event', async () => {
  const stateDir = tempDir();
  const ingestDir = path.join(stateDir, 'session-ingest');
  const lock = path.join(ingestDir, 'event-spool.lock');
  fs.mkdirSync(ingestDir, { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }) + '\n');
  const event = {
    event: 'ManualImport',
    sourceId: 'manual:concurrent-writer',
    tsUtc: '2026-07-13T03:00:00.000Z',
    localDate: '2026-07-13',
    deviceId: 'test-device',
    prompt: 'concurrent evidence',
  };
  const script = [
    "const onmhj = require(process.argv[1]);",
    'onmhj.upsertEventRecord(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));',
  ].join('');
  const child = childProcess.spawn(process.execPath, [
    '-e',
    script,
    path.join(__dirname, '..', 'bin', 'onmhj.js'),
    JSON.stringify(cfg(stateDir)),
    JSON.stringify(event),
  ], { stdio: 'ignore' });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });

  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(fs.existsSync(path.join(stateDir, 'events', '2026-07-13.jsonl')), false);
  fs.unlinkSync(lock);
  await completed;

  assert.equal(readEvents(stateDir)[0].sourceId, 'manual:concurrent-writer');
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

test('raw session publish merges multiple dates in one commit without report changes', () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const repoPath = path.join(root, 'repo');
  const runtime = { ...cfg(stateDir), repoPath };
  initRepo(repoPath);

  const sentinels = {
    daily: path.join(repoPath, 'daily', '2026-07-12.md'),
    report: path.join(repoPath, 'reports', '2026-07-12.md'),
    remoteConfirmation: path.join(repoPath, 'state', 'devices', 'test-device.json'),
    localConfirmation: path.join(stateDir, 'jobs', 'reports', 'confirmed.json'),
  };
  for (const [name, file] of Object.entries(sentinels)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${name}\n`);
  }
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'test: seed report artifacts']);
  fs.appendFileSync(sentinels.daily, 'user edit\n');

  for (const date of ['2026-07-12', '2026-07-13']) {
    const file = path.join(stateDir, 'events', `${date}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      event: 'AISessionTurn',
      sourceId: `codex:session:${date}`,
      tsUtc: `${date}T01:00:00.000Z`,
      localDate: date,
      deviceId: 'test-device',
      prompt: `task ${date}`,
    }) + '\n');
  }

  const before = Object.fromEntries(Object.entries(sentinels).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]));
  const result = onmhj.publishSessionEvents(runtime, { noPush: true });
  const committed = git(repoPath, ['show', '--pretty=format:', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort();

  assert.deepEqual(result, { changed: true, dates: 2 });
  assert.deepEqual(committed, [
    'raw/ai-sessions/2026-07-12.jsonl',
    'raw/ai-sessions/2026-07-13.jsonl',
  ]);
  assert.equal(git(repoPath, ['log', '--format=%s', '-1']), 'data(sessions): publish raw AI sessions');
  assert.match(git(repoPath, ['log', '--format=%B', '-1']), /작업 의도:/);
  assert.equal(fs.readFileSync(sentinels.daily, 'utf8'), before.daily);
  assert.equal(fs.readFileSync(sentinels.report, 'utf8'), before.report);
  assert.equal(fs.readFileSync(sentinels.remoteConfirmation, 'utf8'), before.remoteConfirmation);
  assert.equal(fs.readFileSync(sentinels.localConfirmation, 'utf8'), before.localConfirmation);
  assert.equal(git(repoPath, ['status', '--short']), 'M daily/2026-07-12.md');
});

test('raw session publish reconciles current-device sessions without touching unrelated events', () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const repoPath = path.join(root, 'repo');
  const runtime = { ...cfg(stateDir), repoPath };
  initRepo(repoPath);

  const scope = {
    provider: 'claude',
    sessionId: 'reconciled-session',
    deviceId: 'test-device',
  };
  const rawDir = path.join(repoPath, 'raw', 'ai-sessions');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, '2026-07-12.jsonl'), JSON.stringify({
    event: 'AISessionTurn',
    source: 'claude-transcript',
    sourceId: 'claude:reconciled-session:stale-only-turn',
    turnId: 'stale-only-turn',
    tsUtc: '2026-07-12T01:00:00.000Z',
    localDate: '2026-07-12',
    prompt: '<task-notification>stale</task-notification>',
    ...scope,
  }) + '\n');

  const stored = [{
    event: 'AISessionTurn',
    source: 'claude-transcript',
    sourceId: 'claude:reconciled-session:synthetic-turn',
    turnId: 'synthetic-turn',
    tsUtc: '2026-07-13T00:00:00.000Z',
    localDate: '2026-07-13',
    prompt: 'Base directory for this skill: C:\\skill',
    ...scope,
  }, {
    event: 'AISessionTurn',
    source: 'claude-transcript',
    sourceId: 'claude:reconciled-session:old-real-turn',
    turnId: 'old-real-turn',
    tsUtc: '2026-07-13T00:01:00.000Z',
    localDate: '2026-07-13',
    prompt: 'old replay output',
    ...scope,
  }, {
    event: 'AISessionTurn',
    sourceId: 'claude:other-session:keep-current-device',
    provider: 'claude',
    sessionId: 'other-session',
    turnId: 'keep-current-device',
    deviceId: 'test-device',
    tsUtc: '2026-07-13T00:02:00.000Z',
    localDate: '2026-07-13',
    prompt: 'other local session',
  }, {
    event: 'AISessionTurn',
    sourceId: 'claude:reconciled-session:keep-other-device',
    provider: 'claude',
    sessionId: 'reconciled-session',
    turnId: 'keep-other-device',
    deviceId: 'other-device',
    tsUtc: '2026-07-13T00:03:00.000Z',
    localDate: '2026-07-13',
    prompt: 'other device session',
  }, {
    event: 'ManualImport',
    sourceId: 'manual:keep',
    deviceId: 'test-device',
    tsUtc: '2026-07-13T00:04:00.000Z',
    localDate: '2026-07-13',
    prompt: 'manual evidence',
  }, {
    event: 'AISessionTurn',
    source: 'openai-capture',
    sourceId: 'openai:keep-independent-capture',
    turnId: 'keep-independent-capture',
    tsUtc: '2026-07-13T00:04:30.000Z',
    localDate: '2026-07-13',
    prompt: 'independent canonical evidence',
    ...scope,
  }, {
    event: 'GitCommit',
    sourceId: 'git:keep',
    deviceId: 'test-device',
    tsUtc: '2026-07-13T00:05:00.000Z',
    localDate: '2026-07-13',
  }];
  fs.writeFileSync(
    path.join(rawDir, '2026-07-13.jsonl'),
    stored.map(event => JSON.stringify(event)).join('\n') + '\n',
  );
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'test: seed reconciled raw sessions']);

  const localDir = path.join(stateDir, 'events');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, '2026-07-13.jsonl'), JSON.stringify({
    event: 'AISessionTurn',
    source: 'claude-transcript',
    sourceId: 'claude:reconciled-session:new-real-turn',
    turnId: 'new-real-turn',
    tsUtc: '2026-07-13T01:00:00.000Z',
    localDate: '2026-07-13',
    prompt: 'new canonical task',
    status: 'pending',
    ...scope,
  }) + '\n');

  const cursorFile = path.join(stateDir, 'session-ingest', 'cursors.json');
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({
    version: 5,
    files: {
      'claude-transcript.jsonl': {
        provider: 'claude',
        parserVersion: 5,
        sessionIds: ['reconciled-session'],
      },
    },
  }));

  const result = onmhj.publishSessionEvents(runtime, { noPush: true });

  const published = fs.readFileSync(path.join(rawDir, '2026-07-13.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(result, { changed: true, dates: 2 });
  assert.equal(fs.existsSync(path.join(rawDir, '2026-07-12.jsonl')), false);
  assert.deepEqual(published.map(event => event.sourceId).sort(), [
    'claude:other-session:keep-current-device',
    'claude:reconciled-session:keep-other-device',
    'claude:reconciled-session:new-real-turn',
    'git:keep',
    'manual:keep',
    'openai:keep-independent-capture',
  ]);
});

test('raw session publish stops before touching the repo when quarantine exists', () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const repoPath = path.join(root, 'repo');
  initRepo(repoPath);
  const quarantine = path.join(stateDir, 'session-ingest', 'quarantine', 'failure.json');
  fs.mkdirSync(path.dirname(quarantine), { recursive: true });
  fs.writeFileSync(quarantine, '{}\n');

  assert.throws(
    () => onmhj.publishSessionEvents({ ...cfg(stateDir), repoPath }, { noPush: true }),
    /unresolved transcript parse failure/,
  );
  assert.equal(git(repoPath, ['status', '--short']), '');
});

test('import normalizes GLM, DeepSeek, and vLLM captures without reasoning or arguments', () => {
  const stateDir = tempDir();
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    stateDir,
    timeZone: 'UTC',
    deviceId: 'test-device',
  }));

  childProcess.execFileSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'onmhj.js'),
    'import',
    path.join(__dirname, 'fixtures', 'openai-captures.jsonl'),
  ], { env: { ...process.env, ONMHJ_CONFIG: configFile } });

  const serialized = JSON.stringify(readEvents(stateDir));
  const events = readEvents(stateDir);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.provider), ['glm', 'deepseek', 'vllm']);
  assert.deepEqual(events[0].toolNames, ['inspect']);
  assert.equal(events[2].assistantResponse, 'vllm answer');
  assert.equal(serialized.includes('private'), false);
  assert.equal(serialized.includes('arguments'), false);
});

test('manual import never truncates supplied work evidence', () => {
  const stateDir = tempDir();
  const configFile = path.join(stateDir, 'config.json');
  const importFile = path.join(stateDir, 'import.jsonl');
  const text = `task-${'t'.repeat(400)}`;
  const legacyPreview = `legacy-${'p'.repeat(400)}`;
  fs.writeFileSync(configFile, JSON.stringify({
    stateDir,
    timeZone: 'UTC',
    deviceId: 'test-device',
  }));
  fs.writeFileSync(importFile, [{
    tsUtc: '2026-07-13T01:00:00.000Z',
    sourceId: 'manual:full-text',
    text,
  }, {
    tsUtc: '2026-07-13T01:00:01.000Z',
    sourceId: 'manual:legacy-preview',
    promptPreview: legacyPreview,
  }].map(JSON.stringify).join('\n') + '\n');

  childProcess.execFileSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'onmhj.js'),
    'import',
    importFile,
  ], { env: { ...process.env, ONMHJ_CONFIG: configFile } });

  const events = readEvents(stateDir);
  assert.equal(events[0].prompt, text);
  assert.equal(events[1].promptPreview, legacyPreview);
});
