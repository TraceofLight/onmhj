const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { importEvents, inject } = require('./commands');
const { ENTRY_FILE, config, configPath, setConfigPath } = require('./config');
const { configure } = require('./configure');
const { run } = require('./git');
const { deviceConfirmationFile, eventFile, internalLogFile } = require('./paths');
const { flush } = require('./publish');
const { reportRuntime } = require('./report-backend');
const { reportContract } = require('./report-contract');
const {
  enqueueReportJob,
  listReportJobs,
  readLocalConfirmation,
  readReportJob,
  writeReportJob,
} = require('./report-jobs');
const { tryScheduleReportJobs } = require('./report-schedule');
const { validateReport } = require('./report-validation');
const { processReportJobs, runReportJob } = require('./report-worker');
const { ingestSessionFiles } = require('./session-ingest');
const { appendLine, readJson, writeJson } = require('./util');

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-'));
  const originalConfigPath = configPath();
  setConfigPath(path.join(tmp, 'config.json'));
  try {
  const repo = path.join(tmp, 'repo');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(repo);
  run('git', ['init'], repo);
  run('git', ['config', 'user.email', 'onmhj@example.local'], repo);
  run('git', ['config', 'user.name', 'onmhj'], repo);
  writeJson(configPath(), { repoPath: repo, stateDir: state, timeZone: 'Asia/Seoul', reportLanguage: 'ko' });
  const transcript = path.join(tmp, 'codex-session.jsonl');
  fs.writeFileSync(transcript, [
    { timestamp: '2026-07-09T01:00:00.000Z', type: 'session_meta', payload: { session_id: 'selftest-session', cwd: repo } },
    { timestamp: '2026-07-09T01:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'selftest-turn' } },
    { timestamp: '2026-07-09T01:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'canonical selftest task' } },
    { timestamp: '2026-07-09T01:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'selftest-turn', last_agent_message: 'canonical selftest answer' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const ingested = await ingestSessionFiles(config(), [{ provider: 'codex', path: transcript }]);
  if (ingested.changed !== 1 || ingested.failures !== 0) throw new Error('session ingestion failed');
  const existingRaw = path.join(repo, 'raw', 'ai-sessions', '2026-07-09.jsonl');
  fs.mkdirSync(path.dirname(existingRaw), { recursive: true });
  fs.writeFileSync(existingRaw, JSON.stringify({
    ts: '2026-07-09T00:30:00.000Z',
    tsUtc: '2026-07-09T00:30:00.000Z',
    timeZone: 'Asia/Seoul',
    localDate: '2026-07-09',
    event: 'UserPromptSubmit',
    deviceId: 'other-device',
    cwd: repo,
    gitRoot: repo,
    promptPreview: 'other device work',
  }) + '\n');
  appendLine(eventFile(config(), '2026-07-08'), JSON.stringify({
    ts: '2026-07-08T15:00:00.000Z',
    tsUtc: '2026-07-08T15:00:00.000Z',
    timeZone: 'Asia/Seoul',
    localDate: '2026-07-09',
    event: 'UserPromptSubmit',
    cwd: repo,
    gitRoot: repo,
    promptPreview: 'test work token=redaction-fixture-value',
  }));
  appendLine(eventFile(config(), '2026-07-09'), JSON.stringify({
    ts: '2026-07-09T15:00:00.000Z',
    tsUtc: '2026-07-09T15:00:00.000Z',
    timeZone: 'Asia/Seoul',
    localDate: '2026-07-10',
    event: 'UserPromptSubmit',
    cwd: repo,
    gitRoot: repo,
    promptPreview: 'next day work',
  }));
  flush('2026-07-09', { noPush: true });
  const remote = path.join(tmp, 'remote.git');
  run('git', ['init', '--bare', remote], tmp);
  run('git', ['remote', 'add', 'origin', remote], repo);
  run('git', ['push', '-u', 'origin', 'master'], repo);
  const raw = fs.readFileSync(path.join(repo, 'raw', 'ai-sessions', '2026-07-09.jsonl'), 'utf8');
  if (fs.existsSync(path.join(repo, 'daily', '2026-07-09.md'))) throw new Error('daily file must not be created');
  if (!raw.includes('canonical selftest answer')) throw new Error('assistant evidence missing');
  if (!raw.includes('"deviceId":"other-device"')) throw new Error('existing raw event was not preserved');
  if (raw.includes('redaction-fixture-value')) {
    throw new Error('secret redaction failed');
  }
  tryScheduleReportJobs(config(), new Date('2026-07-11T00:00:00.000Z'), { spawn: false });
  const queuedDates = listReportJobs(config()).map(item => item.date);
  if (!queuedDates.includes('2026-07-09') || !queuedDates.includes('2026-07-10')) {
    throw new Error('unconfirmed report dates were not queued');
  }
  const createSelftestReport = async (_cfg, date) => validateReport([
    `# ${date} 뭐 했지`,
    '',
    '## 오늘의 요약',
    '- selftest',
    '',
    '## 작업별 기록',
    '',
    '### T1. selftest',
    '',
    ...reportContract('ko').taskSections.flatMap(section => [`#### ${section}`, '- selftest', '']),
  ].join('\n'), date, 'ko', '', [], { requireTaskFormat: true });
  await runReportJob(config(), '2026-07-09', { generateReport: createSelftestReport });
  await runReportJob(config(), '2026-07-10', { generateReport: createSelftestReport });
  const job = readReportJob(config(), '2026-07-09');
  if (!job || job.status !== 'completed') throw new Error('report job did not complete');
  const confirmed = readLocalConfirmation(config()).confirmedThrough;
  if (confirmed !== '2026-07-10') throw new Error('local confirmation did not advance');
  const deviceConfirmed = readJson(deviceConfirmationFile(config()), {});
  if (deviceConfirmed.confirmedThrough !== '2026-07-10') throw new Error('device confirmation did not advance');
  writeJson(deviceConfirmationFile(config(), 'other-device'), {
    deviceId: 'other-device',
    confirmedThrough: '2026-07-08',
    updatedAt: new Date().toISOString(),
  });
  tryScheduleReportJobs(config(), new Date('2026-07-11T00:00:00.000Z'), { spawn: false });
  if (readReportJob(config(), '2026-07-09').status !== 'completed') {
    throw new Error('slower remote device requeued a valid completed report');
  }
  enqueueReportJob(config(), '2026-07-09', { force: true });
  writeReportJob(config(), {
    ...readReportJob(config(), '2026-07-09'),
    status: 'failed',
    nextAttemptAt: '2999-01-01T00:00:00.000Z',
  });
  const blockedDelay = await processReportJobs(config());
  const blockedNextJob = readReportJob(config(), '2026-07-10');
  if (blockedDelay <= 0) throw new Error('worker did not wait for earliest retry');
  if (!blockedNextJob || blockedNextJob.status !== 'completed' || blockedNextJob.attempts !== 1) {
    throw new Error('later report ran before earlier retry was due');
  }
  const hookRun = childProcess.spawnSync(process.execPath, [ENTRY_FILE, 'hook', 'UserPromptSubmit'], {
    env: { ...process.env, ONMHJ_CONFIG: configPath() },
    input: JSON.stringify({ cwd: repo, session_id: 'selftest', prompt: 'hook token=redaction-fixture-value' }),
    encoding: 'utf8',
  });
  if (hookRun.status !== 0) throw new Error((hookRun.stderr || hookRun.stdout || 'hook selftest failed').trim());
  const internal = fs.readFileSync(internalLogFile(config()), 'utf8');
  if (!internal.includes('"action":"hook_start"')) throw new Error('hook_start log missing');
  if (!internal.includes('"action":"hook_success"')) throw new Error('hook_success log missing');
  configure({ timeZone: 'UTC' });
  const updated = config();
  if (updated.timeZone !== 'UTC') throw new Error('config update failed');
  if (updated.reportAgent !== 'auto') throw new Error('default report agent must be auto');
  configure({ deviceId: 'test-device' });
  if (config().deviceId !== 'test-device') throw new Error('device config failed');
  configure({ reportLanguage: 'en' });
  if (config().reportLanguage !== 'en') throw new Error('report language config failed');
  configure({ reportAgent: 'codex' });
  if (config().reportAgent !== 'codex') throw new Error('report agent config failed');
  configure({ reportAgentModel: 'test-agent-model', reportAgentEffort: 'low', reportTimeoutMinutes: '20' });
  const agentCfg = config();
  if (agentCfg.reportAgentModel !== 'test-agent-model' || agentCfg.reportAgentEffort !== 'low' || agentCfg.reportTimeoutMinutes !== 20) {
    throw new Error('report agent runtime config failed');
  }
  configure({ ownerName: 'onmhj-owner', ownerEmail: 'owner@example.local' });
  const ownerCfg = config();
  if (ownerCfg.ownerName !== 'onmhj-owner' || ownerCfg.ownerEmail !== 'owner@example.local') {
    throw new Error('owner config failed');
  }
  if (updated.reportAuth !== 'agent') throw new Error('default report auth must be agent');
  configure({
    reportAuth: 'api',
    reportApiBaseUrl: 'https://example.invalid/v1',
    reportApiModel: 'test-model',
    reportApiKeyEnv: 'ONMHJ_TEST_KEY',
  });
  const apiCfg = config();
  const apiRuntime = reportRuntime(apiCfg);
  if (apiRuntime.auth !== 'api' || apiRuntime.baseUrl !== 'https://example.invalid/v1' || apiRuntime.model !== 'test-model') {
    throw new Error('api report config failed');
  }
  inject({ date: '2026-07-09', cwd: repo, text: 'manual token=redaction-fixture-value', sourceId: 'selftest-inject' });
  const imported = fs.readFileSync(eventFile(config(), '2026-07-09'), 'utf8');
  if (!imported.includes('"sourceId":"selftest-inject"')) throw new Error('manual inject missing');
  if (imported.includes('redaction-fixture-value')) throw new Error('manual inject redaction failed');
  const importFile = path.join(tmp, 'import.jsonl');
  fs.writeFileSync(importFile, JSON.stringify({
    tsUtc: '2026-07-09T01:00:00.000Z',
    localDate: '2026-07-09',
    cwd: repo,
    source: 'selftest',
    sourceId: 'selftest-import',
    promptPreview: 'import token=redaction-import-fixture',
  }) + '\n');
  importEvents(importFile);
  const afterImport = fs.readFileSync(eventFile(config(), '2026-07-09'), 'utf8');
  if (!afterImport.includes('"sourceId":"selftest-import"')) throw new Error('manual import missing');
  if (afterImport.includes('redaction-import-fixture')) throw new Error('manual import redaction failed');
  process.stdout.write('selftest ok\n');
  } finally {
    setConfigPath(originalConfigPath);
  }
}

module.exports = {
  selftest,
};
