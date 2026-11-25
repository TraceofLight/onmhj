const fs = require('fs');
const path = require('path');
const { loadEvents } = require('./events');
const {
  deviceConfirmationDir,
  deviceConfirmationFile,
  localConfirmationFile,
  reportJobFile,
  reportJobsDir,
} = require('./paths');
const { previousLocalDateKey, readJson, utcDateKey, writeJson } = require('./util');

function readReportJob(cfg, date) {
  return readJson(reportJobFile(cfg, date), null);
}

function writeReportJob(cfg, job) {
  writeJson(reportJobFile(cfg, job.date), job);
}

function readLocalConfirmation(cfg) {
  return readJson(localConfirmationFile(cfg), {});
}

function writeLocalConfirmation(cfg, confirmedThrough) {
  const current = readLocalConfirmation(cfg).confirmedThrough || '';
  const next = [current, confirmedThrough].filter(Boolean).sort().at(-1) || '';
  writeJson(localConfirmationFile(cfg), {
    deviceId: cfg.deviceId,
    confirmedThrough: next,
    updatedAt: new Date().toISOString(),
  });
}

function readDeviceConfirmations(cfg) {
  try {
    return fs.readdirSync(deviceConfirmationDir(cfg))
      .filter(file => file.endsWith('.json'))
      .map(file => readJson(path.join(deviceConfirmationDir(cfg), file), null))
      .filter(item => item && item.confirmedThrough);
  } catch {
    return [];
  }
}

function writeDeviceConfirmation(cfg, confirmedThrough) {
  const target = deviceConfirmationFile(cfg);
  const current = readJson(target, {}).confirmedThrough || '';
  const local = readLocalConfirmation(cfg).confirmedThrough || '';
  const next = [current, local, confirmedThrough].filter(Boolean).sort().at(-1) || '';
  writeJson(target, {
    deviceId: cfg.deviceId,
    confirmedThrough: next,
    updatedAt: new Date().toISOString(),
    timeZone: cfg.timeZone,
  });
  return target;
}

function minDateKey(values) {
  return values.filter(Boolean).sort()[0] || '';
}

function localEventDates(cfg, throughDate) {
  const dates = new Set();
  const dir = path.join(cfg.stateDir, 'events');
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .map(file => path.join(dir, file));
  } catch {
    return [];
  }
  for (const event of files.flatMap(loadEvents)) {
    const date = event.localDate || (event.ts ? utcDateKey(new Date(event.ts)) : '');
    if (date && date <= throughDate) dates.add(date);
  }
  return [...dates].sort();
}

function reportCandidateDates(cfg, throughDate) {
  const dates = new Set(localEventDates(cfg, throughDate));
  const rawDir = path.join(cfg.repoPath, 'raw', 'ai-sessions');
  try {
    for (const file of fs.readdirSync(rawDir)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (match && match[1] <= throughDate) dates.add(match[1]);
    }
  } catch {}
  return [...dates].sort();
}

function listReportJobs(cfg) {
  try {
    return fs.readdirSync(reportJobsDir(cfg))
      .filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .map(file => readJson(path.join(reportJobsDir(cfg), file), null))
      .filter(Boolean)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  } catch {
    return [];
  }
}

function enqueueReportJob(cfg, date, opts = {}) {
  const current = readReportJob(cfg, date);
  if (current && current.status === 'completed' && !opts.force) return null;
  const now = new Date().toISOString();
  const job = {
    date,
    status: 'pending',
    attempts: current && current.attempts ? current.attempts : 0,
    createdAt: current && current.createdAt ? current.createdAt : now,
    updatedAt: now,
    nextAttemptAt: opts.force ? now : (current && current.nextAttemptAt ? current.nextAttemptAt : now),
    lastError: current && current.lastError ? current.lastError : '',
  };
  writeReportJob(cfg, job);
  return job;
}

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.pow(2, Math.min(attempts, 6)) * 60 * 1000));
}

function confirmedFloor(cfg) {
  const local = readLocalConfirmation(cfg).confirmedThrough || '';
  const remote = minDateKey(readDeviceConfirmations(cfg).map(item => item.confirmedThrough));
  return minDateKey([local, remote]);
}

function reportScheduleState(cfg, now = new Date()) {
  const localConfirmedThrough = readLocalConfirmation(cfg).confirmedThrough || '';
  const remoteConfirmedFloor = minDateKey(readDeviceConfirmations(cfg).map(item => item.confirmedThrough));
  return {
    throughDate: previousLocalDateKey(now, cfg.timeZone),
    localConfirmedThrough,
    remoteConfirmedFloor,
    confirmedFloor: minDateKey([localConfirmedThrough, remoteConfirmedFloor]),
  };
}

module.exports = {
  confirmedFloor,
  enqueueReportJob,
  listReportJobs,
  localEventDates,
  readLocalConfirmation,
  readReportJob,
  reportCandidateDates,
  reportScheduleState,
  retryDelayMs,
  writeDeviceConfirmation,
  writeLocalConfirmation,
  writeReportJob,
};
