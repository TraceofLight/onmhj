const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { ENTRY_FILE, configPath } = require('./config');
const { writeInternalLog } = require('./log');
const { workerLogFile } = require('./paths');
const { rawReferences } = require('./report-contract');
const {
  confirmedFloor,
  enqueueReportJob,
  readReportJob,
  reportCandidateDates,
  reportScheduleState,
} = require('./report-jobs');
const { validateReport } = require('./report-validation');

function hasValidReport(cfg, date) {
  try {
    const rawTarget = path.join(cfg.repoPath, 'raw', 'ai-sessions', date + '.jsonl');
    const raw = fs.existsSync(rawTarget) ? fs.readFileSync(rawTarget, 'utf8') : '';
    validateReport(
      fs.readFileSync(path.join(cfg.repoPath, 'reports', date + '.md'), 'utf8'),
      date,
      cfg.reportLanguage,
      '',
      rawReferences(raw),
    );
    return true;
  } catch {
    return false;
  }
}

function contiguousReportThrough(cfg, date) {
  const floor = confirmedFloor(cfg);
  let through = floor;
  for (const candidate of reportCandidateDates(cfg, date).filter(item => item > floor && item <= date)) {
    if (!hasValidReport(cfg, candidate)) break;
    through = candidate;
  }
  return through > floor ? through : '';
}

function shouldScheduleReportDate(cfg, date, state) {
  if (!hasValidReport(cfg, date)) return true;
  return !state.localConfirmedThrough || date > state.localConfirmedThrough;
}

function tryScheduleReportJobs(cfg, now = new Date(), opts = {}) {
  const state = reportScheduleState(cfg, now);
  let count = 0;
  for (const date of reportCandidateDates(cfg, state.throughDate)) {
    const current = readReportJob(cfg, date);
    if (!shouldScheduleReportDate(cfg, date, state)) continue;
    const job = enqueueReportJob(cfg, date, { force: current && current.status === 'completed' });
    if (!job) continue;
    count += 1;
    writeInternalLog(cfg, 'report_job_enqueued', {
      date,
      confirmedFloor: state.confirmedFloor,
      status: job.status,
      attempts: job.attempts,
    });
  }
  if (!count) return false;
  writeInternalLog(cfg, 'report_job_scan', { confirmedFloor: state.confirmedFloor, throughDate: state.throughDate, queued: count });
  if (opts.spawn !== false) spawnWorker(cfg);
  return true;
}

function spawnWorker(cfg) {
  fs.mkdirSync(path.dirname(workerLogFile(cfg)), { recursive: true });
  const out = fs.openSync(workerLogFile(cfg), 'a');
  const child = childProcess.spawn(process.execPath, [ENTRY_FILE, 'worker'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ONMHJ_CONFIG: configPath() },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
}

module.exports = {
  contiguousReportThrough,
  hasValidReport,
  spawnWorker,
  tryScheduleReportJobs,
};
