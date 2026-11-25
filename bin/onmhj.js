#!/usr/bin/env node
const { catchup, sessions } = require('./cli/catchup');
const { importEvents, inject, schedule, status } = require('./cli/commands');
const { config, setConfigPath } = require('./cli/config');
const { configure, parseOptions, register } = require('./cli/configure');
const { upsertEventRecord } = require('./cli/event-spool');
const { mergeEvents } = require('./cli/events');
const { hook } = require('./cli/hook');
const { releaseLock } = require('./cli/locks');
const { errorDetails, writeInternalLog } = require('./cli/log');
const { flush, publishSessionEvents, runFullReport } = require('./cli/publish');
const { extractExternalReferences } = require('./cli/references');
const { requestApi } = require('./cli/report-backend');
const { generateReport } = require('./cli/report-generate');
const { readReportJob, reportScheduleState } = require('./cli/report-jobs');
const { buildReportPrompt } = require('./cli/report-prompt');
const { tryScheduleReportJobs } = require('./cli/report-schedule');
const { completeReportReferences, validateReport } = require('./cli/report-validation');
const { processReportJobs, runEjmhj, worker } = require('./cli/report-worker');
const { selftest } = require('./cli/selftest');
const { hasSessionFailure, ingestKnownSessions, ingestSessionFiles } = require('./cli/session-ingest');
const { usage } = require('./cli/usage');

async function main() {
  const [cmd, first, ...rest] = process.argv.slice(2);
  const opts = parseOptions([first, ...rest].filter(Boolean));
  if (cmd === 'hook') return hook(first || 'unknown');
  if (cmd === 'register') return register(first, opts);
  if (cmd === 'config') return configure(opts);
  if (cmd === 'inject') return inject(opts);
  if (cmd === 'import') return importEvents(first);
  if (cmd === 'sessions') return sessions(opts);
  if (cmd === 'catchup') return catchup();
  if (cmd === 'schedule') return schedule(first);
  if (cmd === 'flush') return flush(first && !first.startsWith('--') ? first : undefined, opts);
  if (cmd === 'ejmhj') return runEjmhj(config(), first && !first.startsWith('--') ? first : undefined, opts);
  if (cmd === 'worker') return worker();
  if (cmd === 'status') return status();
  if (cmd === 'selftest') return selftest();
  throw new Error(usage());
}

module.exports = {
  buildReportPrompt,
  catchup,
  completeReportReferences,
  config,
  extractExternalReferences,
  generateReport,
  hasSessionFailure,
  ingestKnownSessions,
  ingestSessionFiles,
  mergeEvents,
  processReportJobs,
  publishSessionEvents,
  requestApi,
  readReportJob,
  releaseLock,
  reportScheduleState,
  runEjmhj,
  runFullReport,
  setConfigPath,
  tryScheduleReportJobs,
  upsertEventRecord,
  validateReport,
};

if (require.main === module) {
  main().catch(err => {
    try {
      writeInternalLog(config(), 'error', {
        command: process.argv.slice(2).join(' '),
        ...errorDetails(err),
      });
    } catch {}
    if (process.argv[2] === 'hook') process.exit(0);
    process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
    process.exit(1);
  });
}
