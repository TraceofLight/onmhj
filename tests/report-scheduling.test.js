const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const onmhj = require('../bin/onmhj.js');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function appendEvent(stateDir, date, event) {
  const file = path.join(stateDir, 'events', date + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

function createConfig() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-schedule-'));
  const cfg = {
    configPath: path.join(tmp, 'config.json'),
    repoPath: path.join(tmp, 'repo'),
    stateDir: path.join(tmp, 'state'),
    promptMode: 'preview',
    timeZone: 'Asia/Seoul',
    deviceId: 'windows-device',
    reportLanguage: 'ko',
  };
  writeJson(cfg.configPath, cfg);
  return cfg;
}

test('queues local unconfirmed date even when another device confirmed through it', () => {
  const cfg = createConfig();
  appendEvent(cfg.stateDir, '2026-07-09', {
    ts: '2026-07-09T01:00:00.000Z',
    tsUtc: '2026-07-09T01:00:00.000Z',
    localDate: '2026-07-09',
    event: 'UserPromptSubmit',
    deviceId: cfg.deviceId,
  });
  writeJson(path.join(cfg.repoPath, 'state', 'devices', 'other-device.json'), {
    deviceId: 'other-device',
    confirmedThrough: '2026-07-09',
  });

  onmhj.setConfigPath(cfg.configPath);
  const runtime = onmhj.config();
  const queued = onmhj.tryScheduleReportJobs(runtime, new Date('2026-07-10T01:00:00.000Z'), { spawn: false });

  assert.equal(queued, true);
  assert.equal(onmhj.readReportJob(runtime, '2026-07-09').status, 'pending');
});

test('report schedule state accepts injected time', () => {
  const cfg = createConfig();
  onmhj.setConfigPath(cfg.configPath);

  const state = onmhj.reportScheduleState(onmhj.config(), new Date('2026-07-10T01:00:00.000Z'));

  assert.equal(state.throughDate, '2026-07-09');
  assert.equal(state.localConfirmedThrough, '');
  assert.equal(state.remoteConfirmedFloor, '');
});

test('requeues a completed date when its final report is missing', () => {
  const cfg = createConfig();
  appendEvent(cfg.stateDir, '2026-07-09', {
    tsUtc: '2026-07-09T01:00:00.000Z',
    localDate: '2026-07-09',
    event: 'UserPromptSubmit',
    deviceId: cfg.deviceId,
  });
  writeJson(path.join(cfg.stateDir, 'jobs', 'reports', 'confirmed.json'), {
    deviceId: cfg.deviceId,
    confirmedThrough: '2026-07-09',
  });
  writeJson(path.join(cfg.stateDir, 'jobs', 'reports', '2026-07-09.json'), {
    date: '2026-07-09',
    status: 'completed',
    attempts: 1,
  });

  onmhj.setConfigPath(cfg.configPath);
  const queued = onmhj.tryScheduleReportJobs(
    onmhj.config(),
    new Date('2026-07-10T01:00:00.000Z'),
    { spawn: false },
  );

  assert.equal(queued, true);
  assert.equal(onmhj.readReportJob(onmhj.config(), '2026-07-09').status, 'pending');
});
