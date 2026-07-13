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
  assert.equal(cursors.files[path.resolve(transcript)].parserVersion, 4);
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
