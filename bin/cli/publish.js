const fs = require('fs');
const path = require('path');
const { cleanupMapCache } = require('../report-map-reduce');
const { config } = require('./config');
const { loadEvents, loadEventsForLocalDate, mergeEvents } = require('./events');
const { assertCleanIndex, commitArtifacts, isGitRepo, syncReportRepo } = require('./git');
const { acquireLock, releaseLock } = require('./locks');
const { writeInternalLog } = require('./log');
const { publicationLockFile } = require('./paths');
const { rawReferences } = require('./report-contract');
const { generateReport } = require('./report-generate');
const {
  localEventDates,
  readLocalConfirmation,
  writeDeviceConfirmation,
  writeLocalConfirmation,
} = require('./report-jobs');
const { contiguousReportThrough } = require('./report-schedule');
const { completeReportReferences, validateReport } = require('./report-validation');
const { hasAnySessionFailure, hasSessionFailure, ingestKnownSessions } = require('./session-ingest');
const {
  isReconciledSessionEvent,
  rawDatesWithReconciledEvents,
  reconciledSessionScopes,
} = require('./session-scopes');
const { localDateKey } = require('./util');

const RAW_SESSION_COMMIT_MESSAGE = `data(sessions): publish raw AI sessions

작업 의도:
- 현재 기기 canonical session 범위 교체
- 다른 기기 및 비-transcript evidence 보존

작업 세부 사항:
- parser cursor 범위의 authoritative raw reconciliation
- daily, reports 및 confirmation 변경 제외`;

function prepareRaw(cfg, key, opts = {}) {
  const pulled = opts.pull === false ? false : syncReportRepo(cfg.repoPath);
  const rawTarget = path.join(cfg.repoPath, 'raw', 'ai-sessions', key + '.jsonl');
  const events = mergeEvents(loadEvents(rawTarget), loadEventsForLocalDate(cfg, key));
  if (!events.length) return null;
  const raw = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  if (opts.write !== false) {
    fs.mkdirSync(path.dirname(rawTarget), { recursive: true });
    fs.writeFileSync(rawTarget, raw);
  }
  return { eventCount: events.length, pulled, raw, rawTarget };
}

function publishSessionEvents(cfg, opts = {}) {
  if (!cfg.repoPath) throw new Error('run `onmhj register <git-repo-path>` first');
  if (!isGitRepo(cfg.repoPath)) throw new Error(`registered path is not a git repo: ${cfg.repoPath}`);
  if (hasAnySessionFailure(cfg)) throw new Error('unresolved transcript parse failure blocks raw session publish');
  const lock = publicationLockFile(cfg);
  if (!acquireLock(lock)) throw new Error('report publication already running');
  try {
    assertCleanIndex(cfg.repoPath);
    const pulled = syncReportRepo(cfg.repoPath);
    const scopes = reconciledSessionScopes(cfg);
    const dates = new Set([
      ...localEventDates(cfg, '9999-12-31'),
      ...rawDatesWithReconciledEvents(cfg, scopes),
    ]);
    const targets = [];
    for (const date of [...dates].sort()) {
      const target = path.join(cfg.repoPath, 'raw', 'ai-sessions', date + '.jsonl');
      const stored = loadEvents(target).filter(event => !isReconciledSessionEvent(event, scopes));
      const events = mergeEvents(stored, loadEventsForLocalDate(cfg, date));
      if (!events.length) {
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
          targets.push(target);
        }
        continue;
      }
      const raw = events.map(event => JSON.stringify(event)).join('\n') + '\n';
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === raw) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, raw);
      targets.push(target);
    }
    const changed = targets.length > 0 && commitArtifacts(cfg, 'sessions', targets, {
      ...opts,
      message: RAW_SESSION_COMMIT_MESSAGE,
    });
    writeInternalLog(cfg, 'sessions_publish', {
      changed,
      dates: targets.length,
      pulled,
      pushed: changed && !opts.noPush,
    });
    process.stdout.write(`${changed ? 'published' : 'no raw session changes'} dates=${targets.length}\n`);
    return { changed, dates: targets.length };
  } finally {
    releaseLock(lock);
  }
}

function flushUnlocked(date, opts) {
  const cfg = config();
  if (!cfg.repoPath) throw new Error('run `onmhj register <git-repo-path>` first');
  if (!isGitRepo(cfg.repoPath)) throw new Error(`registered path is not a git repo: ${cfg.repoPath}`);
  assertCleanIndex(cfg.repoPath);

  const key = date || localDateKey(new Date(), cfg.timeZone);
  const prepared = prepareRaw(cfg, key);
  if (!prepared) {
    writeInternalLog(cfg, 'flush_no_events', { date: key });
    process.stdout.write(`no events for ${key}\n`);
    return;
  }
  const changed = commitArtifacts(cfg, key, [prepared.rawTarget], opts);
  writeInternalLog(cfg, 'flush', {
    date: key,
    eventCount: prepared.eventCount,
    deviceId: cfg.deviceId,
    rawTarget: prepared.rawTarget,
    pulled: prepared.pulled,
    pushed: !opts.noPush,
  });
  process.stdout.write(`${changed ? 'flushed' : 'no git changes for'} ${key}\n`);
}

function flush(date, opts) {
  const cfg = config();
  const lock = publicationLockFile(cfg);
  if (!acquireLock(lock)) throw new Error('report publication already running');
  try {
    return flushUnlocked(date, opts);
  } finally {
    releaseLock(lock);
  }
}

async function runFullReportUnlocked(cfg, date, opts = {}) {
  if (!cfg.repoPath) throw new Error('run `onmhj register <git-repo-path>` first');
  if (!isGitRepo(cfg.repoPath)) throw new Error(`registered path is not a git repo: ${cfg.repoPath}`);
  const ingest = opts.ingestSessions || ingestKnownSessions;
  await ingest(cfg);
  if (hasSessionFailure(cfg, date)) throw new Error(`unresolved transcript parse failure for ${date}`);
  assertCleanIndex(cfg.repoPath);
  const prepared = prepareRaw(cfg, date, { write: false });
  if (!prepared) throw new Error(`no events for ${date}`);
  const createReport = opts.generateReport || generateReport;
  const reportTarget = path.join(cfg.repoPath, 'reports', date + '.md');
  const previousReport = fs.existsSync(reportTarget) ? fs.readFileSync(reportTarget, 'utf8') : '';
  const references = rawReferences(prepared.raw);
  const generatedReport = await createReport(cfg, date, prepared.raw, { previousReport });
  const report = validateReport(
    completeReportReferences(generatedReport, references, cfg.reportLanguage),
    date,
    cfg.reportLanguage,
    previousReport,
    references,
    { requireTaskFormat: true },
  );
  fs.mkdirSync(path.dirname(prepared.rawTarget), { recursive: true });
  fs.writeFileSync(prepared.rawTarget, prepared.raw);
  fs.mkdirSync(path.dirname(reportTarget), { recursive: true });
  fs.writeFileSync(reportTarget, report);
  const localConfirmedThrough = readLocalConfirmation(cfg).confirmedThrough || '';
  const confirmationThrough = opts.noPush
    ? ''
    : (contiguousReportThrough(cfg, date) || (localConfirmedThrough && date <= localConfirmedThrough ? localConfirmedThrough : ''));
  const confirmTarget = confirmationThrough ? writeDeviceConfirmation(cfg, confirmationThrough) : '';
  commitArtifacts(
    cfg,
    date,
    [prepared.rawTarget, reportTarget, ...(confirmTarget ? [confirmTarget] : [])],
    opts,
  );
  if (!opts.noPush && confirmationThrough) {
    writeLocalConfirmation(cfg, confirmationThrough);
    cleanupMapCache(cfg.stateDir, date);
  }
  writeInternalLog(cfg, 'report', {
    date,
    eventCount: prepared.eventCount,
    rawTarget: prepared.rawTarget,
    reportTarget,
    confirmTarget,
    pulled: prepared.pulled,
    pushed: !opts.noPush,
  });
  process.stdout.write(`reported ${date}\n`);
  return reportTarget;
}

async function runFullReport(cfg, date, opts = {}) {
  const lock = publicationLockFile(cfg);
  if (!acquireLock(lock)) throw new Error('report publication already running');
  try {
    return await runFullReportUnlocked(cfg, date, opts);
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  flush,
  prepareRaw,
  publishSessionEvents,
  runFullReport,
};
