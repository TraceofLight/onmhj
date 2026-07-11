const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const onmhj = require('../bin/onmhj.js');

const date = '2026-07-11';

function validReport() {
  return `# ${date} 어제 뭐 했지

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
    promptMode: 'preview',
    timeZone: 'Asia/Seoul',
    deviceId: 'test-device',
    reportLanguage: 'ko',
    reportAuth: 'agent',
  };
}

test('builds a final-report prompt for the work date and evidence', () => {
  const prompt = onmhj.buildReportPrompt(date, '# daily evidence', '{"event":"UserPromptSubmit"}\n');

  assert.match(prompt, /2026-07-11/);
  assert.match(prompt, /# daily evidence/);
  assert.match(prompt, /UserPromptSubmit/);
  assert.match(prompt, /## 작업 이유/);
  assert.match(prompt, /확인되지 않은 작업을 지어내지/);
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

test('rejects a report missing a required section', () => {
  assert.throws(
    () => onmhj.validateReport(validReport().replace('## 남은 일', '## 기타'), date),
    /남은 일/,
  );
});

test('generates a validated report with Codex agent auth', async () => {
  let invocation;
  const report = await onmhj.generateReport(
    { reportAuth: 'agent' },
    date,
    '# daily evidence',
    '{"event":"UserPromptSubmit"}\n',
    {
      runAgent(command, args, input) {
        invocation = { command, args, input };
        return { status: 0, stdout: validReport(), stderr: '' };
      },
    },
  );

  assert.equal(report, validReport());
  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['exec', '-']);
  assert.match(invocation.input, /daily evidence/);
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
  assert.equal(request.body.model, 'report-model');
  assert.match(request.body.messages[0].content, /daily evidence/);
});

test('rejects incomplete API configuration before requesting a report', async () => {
  await assert.rejects(
    () => onmhj.generateReport({ reportAuth: 'api' }, date, 'daily', 'raw'),
    /API base URL/,
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

test('full pipeline commits raw, daily, report, and confirmation for the same work date', async () => {
  const cfg = createRuntime();

  await onmhj.runFullReport(cfg, date, {
    noPush: true,
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
