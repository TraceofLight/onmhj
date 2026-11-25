const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { isGitRepo, syncReportRepo } = require('./git');
const { acquireLock, lockOwned, releaseLock } = require('./locks');
const { errorDetails, writeInternalLog } = require('./log');
const { publicationLockFile, reportJobLockFile, workerLockFile } = require('./paths');
const { runFullReport } = require('./publish');
const {
  enqueueReportJob,
  listReportJobs,
  readReportJob,
  retryDelayMs,
  writeReportJob,
} = require('./report-jobs');
const { hasValidReport, spawnWorker, tryScheduleReportJobs } = require('./report-schedule');
const { previousLocalDateKey } = require('./util');

async function runReportJob(cfg, date, opts = {}) {
  const lock = reportJobLockFile(cfg, date);
  if (!acquireLock(lock)) return false;
  try {
    const now = new Date().toISOString();
    const current = readReportJob(cfg, date) || enqueueReportJob(cfg, date);
    const attempts = (current.attempts || 0) + 1;
    writeReportJob(cfg, {
      ...current,
      date,
      status: 'running',
      attempts,
      updatedAt: now,
      lastStartedAt: now,
    });
    try {
      const reportTarget = path.join(cfg.repoPath, 'reports', date + '.md');
      const existingReport = hasValidReport(cfg, date)
        ? async () => fs.readFileSync(reportTarget, 'utf8')
        : undefined;
      await runFullReport(cfg, date, existingReport ? { ...opts, generateReport: existingReport } : opts);
      writeReportJob(cfg, {
        ...readReportJob(cfg, date),
        date,
        status: 'completed',
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        lastError: '',
      });
      writeInternalLog(cfg, 'report_job_completed', { date, attempts });
      return true;
    } catch (err) {
      const nextAttemptAt = new Date(Date.now() + retryDelayMs(attempts)).toISOString();
      writeReportJob(cfg, {
        ...readReportJob(cfg, date),
        date,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        nextAttemptAt,
        lastError: err && err.message ? err.message : String(err),
      });
      writeInternalLog(cfg, 'report_job_failed', { date, attempts, nextAttemptAt, ...errorDetails(err) });
      return false;
    }
  } finally {
    releaseLock(lock);
  }
}

async function processReportJobs(cfg, opts = {}) {
  const publicationLock = publicationLockFile(cfg);
  if (!acquireLock(publicationLock)) return 1000;
  try {
    if (cfg.repoPath && isGitRepo(cfg.repoPath)) syncReportRepo(cfg.repoPath);
  } catch (err) {
    writeInternalLog(cfg, 'report_repo_sync_failed', errorDetails(err));
  } finally {
    releaseLock(publicationLock);
  }
  tryScheduleReportJobs(cfg, new Date(), { spawn: false });
  const now = Date.now();
  // Confirmed dates must advance contiguously. Process independent due jobs
  // even when an earlier retry is delayed or fails validation.
  for (const job of listReportJobs(cfg)) {
    if (job.status === 'completed') continue;
    const due = Date.parse(job.nextAttemptAt || job.createdAt || new Date().toISOString());
    if (!Number.isNaN(due) && due > now) {
      continue;
    }
    await runReportJob(cfg, job.date, opts);
  }
  let nextDelay = Infinity;
  for (const job of listReportJobs(cfg)) {
    if (job.status === 'completed') continue;
    const due = Date.parse(job.nextAttemptAt || new Date().toISOString());
    nextDelay = Math.min(nextDelay, Number.isNaN(due) ? 1 : Math.max(1, due - Date.now()));
  }
  return Number.isFinite(nextDelay) ? nextDelay : 0;
}

async function runEjmhj(cfg, date, opts = {}) {
  const key = date || previousLocalDateKey(new Date(), cfg.timeZone);
  const throughDate = previousLocalDateKey(new Date(), cfg.timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`invalid report date: ${key}`);
  if (key > throughDate) throw new Error(`report date must be on or before ${throughDate}`);
  if (opts.noPush) return runFullReport(cfg, key, opts);
  const current = readReportJob(cfg, key);
  enqueueReportJob(cfg, key, { force: current && current.status === 'completed' });
  const delay = await processReportJobs(cfg, opts);
  if (delay && opts.spawn !== false) spawnWorker(cfg);
  return delay;
}

async function worker() {
  const cfg = config();
  const lock = workerLockFile(cfg);
  if (!acquireLock(lock)) {
    writeInternalLog(cfg, 'worker_already_running');
    return;
  }
  writeInternalLog(cfg, 'worker_start');
  const tick = async () => {
    if (!lockOwned(lock)) {
      writeInternalLog(cfg, 'worker_superseded');
      return;
    }
    const nextDelay = await processReportJobs(cfg);
    if (nextDelay) {
      writeInternalLog(cfg, 'worker_sleep', { nextDelayMs: nextDelay });
      setTimeout(tick, nextDelay);
      return;
    }
    releaseLock(lock);
    writeInternalLog(cfg, 'worker_done');
  };
  process.on('exit', () => releaseLock(lock));
  tick();
}

module.exports = {
  processReportJobs,
  runEjmhj,
  runReportJob,
  worker,
};
