const fs = require('fs');
const os = require('os');
const path = require('path');
const { applySchedule, schedulePlan } = require('../schedule');
const { normalizeOpenAIExchange } = require('../session-parsers');
const { ENTRY_FILE, config, configPath } = require('./config');
const { appendEventRecord, upsertEventRecord } = require('./event-spool');
const { loadEventsForLocalDate } = require('./events');
const { findGitRoot, gitValue } = require('./git');
const { writeInternalLog } = require('./log');
const { internalLogFile, workerLogFile } = require('./paths');
const { redactSecrets } = require('./references');
const { reportRuntime } = require('./report-backend');
const { confirmedFloor, listReportJobs, readLocalConfirmation } = require('./report-jobs');
const { normalizedSessionEvent } = require('./session-ingest');
const { usage } = require('./usage');
const { localDateKey, parseJsonFromString } = require('./util');

function scheduleContext(cfg) {
  return {
    home: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    command: [process.execPath, ENTRY_FILE, 'catchup'],
    // Scheduled tasks start with a minimal environment; keep the PATH that finds git and the report agent.
    env: { PATH: process.env.PATH || '', ONMHJ_CONFIG: configPath() },
    logFile: path.join(cfg.stateDir, 'catchup.log'),
  };
}

function schedule(action) {
  const cfg = config();
  const status = applySchedule(action, schedulePlan(process.platform, scheduleContext(cfg)));
  if (action !== 'status') writeInternalLog(cfg, 'schedule', { action, platform: process.platform });
  process.exitCode = status;
}

function normalizeImportedEvent(raw, cfg) {
  const tsUtc = String(raw.tsUtc || raw.ts || new Date().toISOString());
  const date = new Date(tsUtc);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${tsUtc}`);
  const cwd = raw.cwd || raw.gitRoot || process.cwd();
  const gitRoot = raw.gitRoot || findGitRoot(cwd);
  const event = {
    ts: tsUtc,
    tsUtc,
    timeZone: raw.timeZone || cfg.timeZone,
    localDate: raw.localDate || localDateKey(date, raw.timeZone || cfg.timeZone),
    event: raw.event || 'ManualImport',
    deviceId: raw.deviceId || cfg.deviceId,
    cwd,
    gitRoot,
    gitBranch: raw.gitBranch || (gitRoot ? gitValue(['branch', '--show-current'], gitRoot) : ''),
    sessionId: raw.sessionId || raw.session_id || '',
  };
  if (raw.source) event.source = String(raw.source);
  if (raw.sourceId) event.sourceId = String(raw.sourceId);
  if (raw.prompt) event.prompt = redactSecrets(raw.prompt);
  if (raw.promptPreview) event.promptPreview = redactSecrets(raw.promptPreview);
  if (!event.prompt && !event.promptPreview && raw.text) {
    event.prompt = redactSecrets(raw.text);
  }
  return event;
}

function inject(opts) {
  if (!opts.text) throw new Error('inject requires --text=TEXT');
  const cfg = config();
  const raw = {
    tsUtc: opts.tsUtc || (opts.date ? `${opts.date}T00:00:00.000Z` : new Date().toISOString()),
    localDate: opts.date || '',
    cwd: opts.cwd || process.cwd(),
    event: opts.event || 'ManualImport',
    source: opts.source || 'manual',
    sourceId: opts.sourceId || '',
    sessionId: opts.sessionId || '',
    text: opts.text,
  };
  const added = appendEventRecord(cfg, normalizeImportedEvent(raw, cfg));
  process.stdout.write(`${added ? 'injected' : 'skipped duplicate'}\n`);
}

function importEvents(file) {
  if (!file) throw new Error(usage());
  const cfg = config();
  let added = 0;
  let skipped = 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const parsed = parseJsonFromString(line);
    if (!parsed.ok) throw new Error(`invalid JSONL line: ${parsed.error}`);
    const raw = parsed.value;
    const event = raw.request && raw.response
      ? normalizedSessionEvent(cfg, { ...normalizeOpenAIExchange(raw), source: 'openai-capture' })
      : normalizeImportedEvent(raw, cfg);
    if (upsertEventRecord(cfg, event)) added += 1;
    else skipped += 1;
  }
  writeInternalLog(cfg, 'import', { file, added, skipped });
  process.stdout.write(`imported ${added}, skipped ${skipped}\n`);
}

function status() {
  const cfg = config();
  const key = localDateKey(new Date(), cfg.timeZone);
  const events = loadEventsForLocalDate(cfg, key);
  const logFile = internalLogFile(cfg);
  const report = reportRuntime(cfg);
  const jobs = listReportJobs(cfg);
  const localConfirmed = readLocalConfirmation(cfg).confirmedThrough || '(unset)';
  const floor = confirmedFloor(cfg) || '(unset)';
  process.stdout.write([
    `config: ${configPath()}`,
    `state: ${cfg.stateDir}`,
    `internalLog: ${logFile}`,
    `workerLog: ${workerLogFile(cfg)}`,
    `repo: ${cfg.repoPath || '(not registered)'}`,
    `timeZone: ${cfg.timeZone}`,
    `deviceId: ${cfg.deviceId}`,
    `ownerName: ${cfg.ownerName}`,
    `ownerEmail: ${cfg.ownerEmail || '(unset)'}`,
    `autoReport: ${cfg.autoReport}`,
    `reportLanguage: ${cfg.reportLanguage}`,
    `reportAuth: ${report.auth}`,
    `reportAgent: ${cfg.reportAgent}`,
    `reportAgentProvider: ${report.auth === 'agent' ? report.provider : '(inactive)'}`,
    `reportAgentModel: ${report.auth === 'agent' ? report.model : '(inactive)'}`,
    `reportAgentEffort: ${report.auth === 'agent' ? report.effort : '(inactive)'}`,
    `reportTimeoutMinutes: ${cfg.reportTimeoutMinutes}`,
    `reportApiBase: ${cfg.reportApiBaseUrl || '(unset)'}`,
    `reportModel: ${cfg.reportApiModel || '(unset)'}`,
    `reportApiKeyEnv: ${cfg.reportApiKeyEnv}`,
    `reportApiKeyFile: ${cfg.reportApiKeyFile || '(unset)'}`,
    `reportApiEffort: ${cfg.reportApiEffort || '(unset)'}`,
    `reportSegmentAgent: ${cfg.reportSegmentAgent}`,
    `reportRevise: ${cfg.reportRevise}`,
    `reportPipeline: ${cfg.reportPipeline}`,
    `reportApiLightEffort: ${cfg.reportApiLightEffort || '(unset)'}`,
    `reportPrefetch: ${cfg.reportPrefetch}`,
    `confirmedThrough: ${localConfirmed}`,
    `confirmedFloor: ${floor}`,
    `reportJobs: pending=${jobs.filter(job => job.status === 'pending').length} running=${jobs.filter(job => job.status === 'running').length} failed=${jobs.filter(job => job.status === 'failed').length} completed=${jobs.filter(job => job.status === 'completed').length}`,
    `todayEvents: ${events.length}`,
  ].join('\n') + '\n');
}

module.exports = {
  importEvents,
  inject,
  schedule,
  status,
};
