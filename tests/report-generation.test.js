const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const onmhj = require('../bin/onmhj.js');

const date = '2026-07-11';
const codexAgentArgs = [
  'exec',
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--skip-git-repo-check',
  '--sandbox',
  'read-only',
  '--disable',
  'shell_tool',
  '--disable',
  'unified_exec',
  '--disable',
  'multi_agent',
  '--disable',
  'apps',
  '--disable',
  'hooks',
  '--disable',
  'goals',
  '-c',
  'tools.view_image=false',
  '-c',
  'tools.web_search=false',
  '-',
];

function validReport() {
  return validReportFor(date);
}

function validReportFor(reportDate) {
  return `# ${reportDate} 뭐 했지

## 요약
완료 작업 요약

## 작업 이유
- 변경 필요

## 작업 과정
1. 구현

## 결정 사항
- 계약 유지

## 도출 결과
- 검증 완료

## 남은 일
- 없음
`;
}

function createRuntime() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-report-'));
  const repoPath = path.join(tmp, 'repo');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(repoPath);
  childProcess.execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  childProcess.execFileSync('git', ['config', 'user.name', 'onmhj test'], { cwd: repoPath });
  childProcess.execFileSync('git', ['config', 'user.email', 'onmhj@example.test'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  childProcess.execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  childProcess.execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
  const remotePath = path.join(tmp, 'remote.git');
  childProcess.execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
  childProcess.execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath });
  childProcess.execFileSync('git', ['push', '-u', 'origin', 'master'], { cwd: repoPath, stdio: 'ignore' });
  fs.mkdirSync(path.join(stateDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'events', `${date}.jsonl`), JSON.stringify({
    tsUtc: `${date}T01:00:00.000Z`,
    localDate: date,
    timeZone: 'Asia/Seoul',
    deviceId: 'test-device',
    event: 'UserPromptSubmit',
    cwd: repoPath,
    promptPreview: 'implemented automatic reports',
  }) + '\n');
  return {
    repoPath,
    stateDir,
    timeZone: 'Asia/Seoul',
    deviceId: 'test-device',
    reportLanguage: 'ko',
    reportAuth: 'agent',
  };
}

test('builds a final-report prompt for the work date and evidence', () => {
  const prompt = onmhj.buildReportPrompt(date, '# daily evidence', '{"event":"UserPromptSubmit"}\n');

  assert.match(prompt, /2026-07-11/);
  assert.match(prompt, /# 2026-07-11 뭐 했지/);
  assert.match(prompt, /# daily evidence/);
  assert.match(prompt, /UserPromptSubmit/);
  assert.match(prompt, /## 작업 이유/);
  assert.match(prompt, /확인되지 않은 작업을 지어내지/);
  assert.match(prompt, /신뢰할 수 없는 데이터/);
  assert.match(prompt, /도구를 사용하지/);
});

test('report prompt includes prior content with a verbatim preservation rule', () => {
  const previous = validReport().replace('- 변경 필요', '- 기존 고유 내용');
  const prompt = onmhj.buildReportPrompt(date, 'daily', 'raw', 'ko', previous);

  assert.match(prompt, /기존 고유 내용/);
  assert.match(prompt, /그대로 보존/);
});

test('accepts a report with the exact work-date heading and required sections', () => {
  assert.equal(onmhj.validateReport(validReport(), date), validReport());
});

test('rejects a report for a different date', () => {
  assert.throws(
    () => onmhj.validateReport(validReport().replace(date, '2026-07-12'), date),
    /heading/,
  );
});

test('rejects the previous Korean report heading', () => {
  assert.throws(
    () => onmhj.validateReport(validReport().replace('뭐 했지', '어제 뭐 했지'), date),
    /heading/,
  );
});

test('rejects a report missing a required section', () => {
  assert.throws(
    () => onmhj.validateReport(validReport().replace('## 남은 일', '## 기타'), date),
    /남은 일/,
  );
});

test('rejects duplicated or out-of-order report sections', () => {
  assert.throws(
    () => onmhj.validateReport(validReport().replace('## 남은 일', '## 요약\n중복\n\n## 남은 일'), date),
    /duplicate|order/,
  );
  assert.throws(
    () => onmhj.validateReport(
      validReport().replace('## 작업 이유', '## TEMP').replace('## 작업 과정', '## 작업 이유').replace('## TEMP', '## 작업 과정'),
      date,
    ),
    /order/,
  );
});

test('rejects regeneration that drops a prior non-heading line', () => {
  const previous = validReport().replace('- 변경 필요', '- 기존 고유 내용');

  assert.throws(
    () => onmhj.validateReport(validReport(), date, 'ko', previous),
    /preserve prior report content/,
  );
  assert.equal(onmhj.validateReport(previous, date, 'ko', previous), previous);
  assert.equal(onmhj.validateReport(previous, date, 'ko', previous.replace(/\n/g, '\r\n')), previous);
});

test('builds and validates the English final-report contract', () => {
  const report = `# ${date} Yesterday's work

## Summary
- completed

## Work reasons
- needed

## Work process
- implemented

## Decisions
- retained contract

## Results
- verified

## Remaining work
- none
`;
  const prompt = onmhj.buildReportPrompt(date, 'daily', 'raw', 'en');

  assert.match(prompt, /Yesterday's work/);
  assert.match(prompt, /## Work reasons/);
  assert.equal(onmhj.validateReport(report, date, 'en'), report);
  assert.throws(() => onmhj.validateReport(validReport(), date, 'en'), /heading/);
});

test('generates a validated report with Codex agent auth without a plugin root', async () => {
  let invocation;
  const report = await onmhj.generateReport(
    { reportAuth: 'agent' },
    date,
    '# daily evidence',
    '{"event":"UserPromptSubmit"}\n',
    {
      env: {},
      codexCommand: 'codex-native',
      runAgent(command, args, input, options) {
        invocation = { command, args, input, options };
        return { status: 0, stdout: validReport(), stderr: '' };
      },
    },
  );

  assert.equal(report, validReport());
  assert.equal(invocation.command, 'codex-native');
  assert.deepEqual(invocation.args, codexAgentArgs);
  assert.match(invocation.input, /daily evidence/);
  assert.ok(invocation.options.timeout > 0);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(fs.existsSync(invocation.options.cwd), false);
});

test('keeps Codex agent auth when CODEX_PLUGIN_ROOT is present', async () => {
  let invocation;
  await onmhj.generateReport(
    { reportAuth: 'agent' },
    date,
    'daily',
    'raw',
    {
      env: { CODEX_PLUGIN_ROOT: 'codex-plugin' },
      claudeCommand: 'claude-native',
      codexCommand: 'codex-native',
      runAgent(command, args) {
        invocation = { command, args };
        return { status: 0, stdout: validReport(), stderr: '' };
      },
    },
  );

  assert.equal(invocation.command, 'codex-native');
  assert.deepEqual(invocation.args, codexAgentArgs);
});

test('generates a validated report with Claude agent auth', async () => {
  let invocation;
  const env = {
    CLAUDE_PLUGIN_ROOT: 'claude-plugin',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ANTHROPIC_API_KEY: 'test-auth-key',
  };
  const report = await onmhj.generateReport(
    { reportAuth: 'agent' },
    date,
    '# daily evidence',
    '{"event":"UserPromptSubmit"}\n',
    {
      env,
      claudeCommand: 'claude-native',
      codexCommand: 'codex-native',
      runAgent(command, args, input, options) {
        invocation = { command, args, input, options };
        return { status: 0, stdout: validReport(), stderr: '' };
      },
    },
  );

  assert.equal(report, validReport());
  assert.equal(invocation.command, 'claude-native');
  assert.deepEqual(invocation.args, [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--no-session-persistence',
    '--no-chrome',
    '--output-format',
    'text',
  ]);
  assert.match(invocation.input, /daily evidence/);
  assert.equal(invocation.options.timeout, 10 * 60 * 1000);
  assert.equal(invocation.options.windowsHide, true);
  assert.notEqual(invocation.options.env, env);
  assert.deepEqual(invocation.options.env, {
    CLAUDE_PLUGIN_ROOT: 'claude-plugin',
    ANTHROPIC_API_KEY: 'test-auth-key',
  });
  assert.equal(env.CLAUDECODE, '1');
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'cli');
  assert.equal(env.ANTHROPIC_API_KEY, 'test-auth-key');
  assert.equal(fs.existsSync(invocation.options.cwd), false);
});

test('uses ONMHJ_CLAUDE_EXECUTABLE for Claude agent auth', async () => {
  let invokedCommand;
  await onmhj.generateReport(
    { reportAuth: 'agent' },
    date,
    'daily',
    'raw',
    {
      env: {
        CLAUDE_PLUGIN_ROOT: 'claude-plugin',
        ONMHJ_CLAUDE_EXECUTABLE: 'claude-from-env',
      },
      runAgent(command) {
        invokedCommand = command;
        return { status: 0, stdout: validReport(), stderr: '' };
      },
    },
  );

  assert.equal(invokedCommand, 'claude-from-env');
});

test('generates a validated report with OpenAI-compatible API auth', async () => {
  let request;
  const report = await onmhj.generateReport(
    {
      reportAuth: 'api',
      reportApiBaseUrl: 'https://llm.example/v1',
      reportApiModel: 'report-model',
      reportApiKeyEnv: 'ONMHJ_TEST_KEY',
    },
    date,
    '# daily evidence',
    '{"event":"UserPromptSubmit"}\n',
    {
      env: { ONMHJ_TEST_KEY: 'secret-value' },
      async requestApi(url, options, body) {
        request = { url, options, body };
        return { choices: [{ message: { content: validReport() } }] };
      },
    },
  );

  assert.equal(report, validReport());
  assert.equal(request.url, 'https://llm.example/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-value');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.body.model, 'report-model');
  assert.match(request.body.messages[0].content, /daily evidence/);
});

test('rejects incomplete API configuration before requesting a report', async () => {
  await assert.rejects(
    () => onmhj.generateReport({ reportAuth: 'api' }, date, 'daily', 'raw'),
    /API base URL/,
  );
});

test('reports non-JSON API gateway failures clearly', async () => {
  await assert.rejects(
    () => onmhj.requestApi(
      'https://llm.example/v1/chat/completions',
      { method: 'POST' },
      { model: 'report-model' },
      async () => ({
        ok: false,
        status: 504,
        text: async () => 'Gateway Timeout',
      }),
    ),
    /HTTP 504: Gateway Timeout/,
  );
});

test('surfaces Codex report generation failures', async () => {
  await assert.rejects(
    () => onmhj.generateReport(
      { reportAuth: 'agent' },
      date,
      'daily',
      'raw',
      { runAgent: () => ({ status: 1, stdout: '', stderr: 'agent failed' }) },
    ),
    /agent failed/,
  );
});

test('surfaces Claude report generation failures', async () => {
  await assert.rejects(
    () => onmhj.generateReport(
      { reportAuth: 'agent' },
      date,
      'daily',
      'raw',
      {
        env: { CLAUDE_PLUGIN_ROOT: 'claude-plugin' },
        claudeCommand: 'claude-native',
        runAgent: command => ({ status: 1, stdout: '', stderr: `${command} failed` }),
      },
    ),
    /report agent failed: claude-native failed/,
  );
});

test('surfaces Codex process launch errors', async () => {
  await assert.rejects(
    () => onmhj.generateReport(
      { reportAuth: 'agent' },
      date,
      'daily',
      'raw',
      { runAgent: () => ({ status: null, error: new Error('spawn denied') }) },
    ),
    /spawn denied/,
  );
});

test('redacts credential-like values from generated reports', async () => {
  const generated = validReport().replace('검증 완료', 'token=super-secret-report-value 검증 완료');

  const report = await onmhj.generateReport(
    { reportAuth: 'agent', reportLanguage: 'ko' },
    date,
    'daily',
    'raw',
    {
      codexCommand: 'codex-native',
      runAgent: () => ({ status: 0, stdout: generated, stderr: '' }),
    },
  );

  assert.doesNotMatch(report, /super-secret-report-value/);
  assert.match(report, /\[REDACTED\]/);
});

test('full pipeline commits raw, daily, report, and confirmation for the same work date', async () => {
  const cfg = createRuntime();

  await onmhj.runFullReport(cfg, date, {
    generateReport: async () => validReport(),
  });

  assert.ok(fs.existsSync(path.join(cfg.repoPath, 'raw', 'ai-sessions', `${date}.jsonl`)));
  assert.ok(fs.existsSync(path.join(cfg.repoPath, 'daily', `${date}.md`)));
  assert.equal(fs.readFileSync(path.join(cfg.repoPath, 'reports', `${date}.md`), 'utf8'), validReport());
  const remoteConfirmation = JSON.parse(fs.readFileSync(
    path.join(cfg.repoPath, 'state', 'devices', 'test-device.json'),
    'utf8',
  ));
  assert.equal(remoteConfirmation.confirmedThrough, date);
  const localConfirmation = JSON.parse(fs.readFileSync(
    path.join(cfg.stateDir, 'jobs', 'reports', 'confirmed.json'),
    'utf8',
  ));
  assert.equal(localConfirmation.confirmedThrough, date);
  assert.equal(childProcess.execFileSync('git', ['status', '--short'], { cwd: cfg.repoPath, encoding: 'utf8' }), '');
});

test('daily evidence includes the canonical final assistant response', async () => {
  const cfg = createRuntime();
  fs.appendFileSync(path.join(cfg.stateDir, 'events', `${date}.jsonl`), JSON.stringify({
    schemaVersion: 1,
    event: 'AISessionTurn',
    source: 'codex-transcript',
    sourceId: 'codex:session:turn',
    provider: 'codex',
    sessionId: 'session',
    turnId: 'turn',
    tsUtc: `${date}T02:00:00.000Z`,
    localDate: date,
    timeZone: 'Asia/Seoul',
    deviceId: 'test-device',
    cwd: cfg.repoPath,
    prompt: 'canonical task',
    assistantResponse: 'canonical final answer',
    status: 'complete',
  }) + '\n');

  await onmhj.runFullReport(cfg, date, { noPush: true, generateReport: async () => validReport() });

  const daily = fs.readFileSync(path.join(cfg.repoPath, 'daily', `${date}.md`), 'utf8');
  assert.match(daily, /AI 응답/);
  assert.match(daily, /canonical final answer/);
});

test('full pipeline leaves an existing report untouched when regenerated content is destructive', async () => {
  const cfg = createRuntime();
  const reportTarget = path.join(cfg.repoPath, 'reports', `${date}.md`);
  const previous = validReport().replace('- 변경 필요', '- 기존 고유 내용');
  fs.mkdirSync(path.dirname(reportTarget), { recursive: true });
  fs.writeFileSync(reportTarget, previous);

  await assert.rejects(
    () => onmhj.runFullReport(cfg, date, { noPush: true, generateReport: async () => validReport() }),
    /preserve prior report content/,
  );

  assert.equal(fs.readFileSync(reportTarget, 'utf8'), previous);
});

test('report generation failure does not write confirmation', async () => {
  const cfg = createRuntime();

  await assert.rejects(
    () => onmhj.runFullReport(cfg, date, {
      noPush: true,
      generateReport: async () => { throw new Error('generation failed'); },
    }),
    /generation failed/,
  );

  assert.equal(fs.existsSync(path.join(cfg.repoPath, 'state', 'devices', 'test-device.json')), false);
  assert.equal(fs.existsSync(path.join(cfg.stateDir, 'jobs', 'reports', 'confirmed.json')), false);
});

test('unresolved transcript failure blocks report generation and confirmation', async () => {
  const cfg = createRuntime();
  const quarantineDir = path.join(cfg.stateDir, 'session-ingest', 'quarantine');
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.writeFileSync(path.join(quarantineDir, 'failed.json'), JSON.stringify({
    provider: 'codex',
    pathHash: 'safe-hash',
    offset: 42,
    affectedDate: date,
    parserVersion: 1,
    schemaSignature: 'event_msg:user_message',
    code: 'codex_invalid_user_message',
  }));
  let generated = false;

  await assert.rejects(
    () => onmhj.runFullReport(cfg, date, {
      generateReport: async () => {
        generated = true;
        return validReport();
      },
    }),
    /unresolved transcript parse failure/,
  );

  assert.equal(generated, false);
  assert.equal(fs.existsSync(path.join(cfg.stateDir, 'jobs', 'reports', 'confirmed.json')), false);
});

test('no-push report generation does not confirm the work date', async () => {
  const cfg = createRuntime();

  await onmhj.runFullReport(cfg, date, {
    noPush: true,
    generateReport: async () => validReport(),
  });

  assert.ok(fs.existsSync(path.join(cfg.repoPath, 'reports', `${date}.md`)));
  assert.equal(fs.existsSync(path.join(cfg.repoPath, 'state', 'devices', 'test-device.json')), false);
  assert.equal(fs.existsSync(path.join(cfg.stateDir, 'jobs', 'reports', 'confirmed.json')), false);
});

test('refuses to publish a report over unrelated staged changes', async () => {
  const cfg = createRuntime();
  const unrelated = path.join(cfg.repoPath, 'unrelated.txt');
  fs.writeFileSync(unrelated, 'user change\n');
  childProcess.execFileSync('git', ['add', 'unrelated.txt'], { cwd: cfg.repoPath });

  await assert.rejects(
    () => onmhj.runFullReport(cfg, date, { generateReport: async () => validReport() }),
    /staged changes/,
  );

  assert.equal(
    childProcess.execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: cfg.repoPath, encoding: 'utf8' }).trim(),
    'unrelated.txt',
  );
});

test('refuses concurrent publication while the report repo lock is held', async () => {
  const cfg = createRuntime();
  const lock = path.join(cfg.stateDir, 'jobs', 'reports', 'publication.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));

  await assert.rejects(
    () => onmhj.runFullReport(cfg, date, { generateReport: async () => validReport() }),
    /publication already running/,
  );
});

test('worker waits without failing jobs while another publication holds the repo lock', async () => {
  const cfg = createRuntime();
  const jobsDir = path.join(cfg.stateDir, 'jobs', 'reports');
  fs.mkdirSync(jobsDir, { recursive: true });
  const jobFile = path.join(jobsDir, `${date}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({
    date,
    status: 'pending',
    attempts: 0,
    createdAt: '2026-07-11T00:00:00.000Z',
    nextAttemptAt: '2000-01-01T00:00:00.000Z',
  }));
  fs.writeFileSync(path.join(jobsDir, 'publication.lock'), JSON.stringify({
    pid: process.pid,
    ts: new Date().toISOString(),
  }));

  const delay = await onmhj.processReportJobs(cfg, {
    generateReport: async () => validReport(),
  });

  assert.ok(delay > 0 && delay <= 1000);
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
});

test('ejmhj preserves ordered retries before confirming a later work date', async () => {
  const cfg = createRuntime();
  const earlierDate = '2026-07-10';
  fs.writeFileSync(path.join(cfg.stateDir, 'events', `${earlierDate}.jsonl`), JSON.stringify({
    tsUtc: `${earlierDate}T01:00:00.000Z`,
    localDate: earlierDate,
    timeZone: 'Asia/Seoul',
    deviceId: cfg.deviceId,
    event: 'UserPromptSubmit',
    cwd: cfg.repoPath,
    promptPreview: 'earlier work',
  }) + '\n');
  const jobsDir = path.join(cfg.stateDir, 'jobs', 'reports');
  fs.mkdirSync(jobsDir, { recursive: true });
  const earlierJobFile = path.join(jobsDir, `${earlierDate}.json`);
  fs.writeFileSync(earlierJobFile, JSON.stringify({
    date: earlierDate,
    status: 'failed',
    attempts: 1,
    createdAt: '2026-07-10T00:00:00.000Z',
    nextAttemptAt: '2999-01-01T00:00:00.000Z',
  }));
  const options = {
    generateReport: async (_cfg, workDate) => validReportFor(workDate),
    spawn: false,
  };

  const delay = await onmhj.runEjmhj(cfg, date, options);

  assert.ok(delay > 0);
  assert.equal(fs.existsSync(path.join(cfg.repoPath, 'reports', `${date}.md`)), false);
  assert.equal(fs.existsSync(path.join(jobsDir, 'confirmed.json')), false);

  const earlierJob = JSON.parse(fs.readFileSync(earlierJobFile, 'utf8'));
  earlierJob.nextAttemptAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(earlierJobFile, JSON.stringify(earlierJob));
  await onmhj.runEjmhj(cfg, date, options);

  assert.ok(fs.existsSync(path.join(cfg.repoPath, 'reports', `${earlierDate}.md`)));
  assert.ok(fs.existsSync(path.join(cfg.repoPath, 'reports', `${date}.md`)));
  const confirmed = JSON.parse(fs.readFileSync(path.join(jobsDir, 'confirmed.json'), 'utf8'));
  assert.equal(confirmed.confirmedThrough, date);
});

test('regenerating an older report does not move confirmation backward', async () => {
  const cfg = createRuntime();
  const confirmationFile = path.join(cfg.stateDir, 'jobs', 'reports', 'confirmed.json');
  fs.mkdirSync(path.dirname(confirmationFile), { recursive: true });
  fs.writeFileSync(confirmationFile, JSON.stringify({
    deviceId: cfg.deviceId,
    confirmedThrough: '2026-07-12',
  }));

  await onmhj.runFullReport(cfg, date, { generateReport: async () => validReport() });

  const local = JSON.parse(fs.readFileSync(confirmationFile, 'utf8'));
  const remote = JSON.parse(fs.readFileSync(
    path.join(cfg.repoPath, 'state', 'devices', `${cfg.deviceId}.json`),
    'utf8',
  ));
  assert.equal(local.confirmedThrough, '2026-07-12');
  assert.equal(remote.confirmedThrough, '2026-07-12');
});
