const { config } = require('./config');
const { appendEventRecord } = require('./event-spool');
const { findGitRoot, gitValue } = require('./git');
const { errorDetails, writeInternalLog } = require('./log');
const { redactSecrets } = require('./references');
const { tryScheduleReportJobs } = require('./report-schedule');
const { rememberSessionSource } = require('./session-sources');
const { localDateKey, parseJsonFromString, readStdin } = require('./util');

function parsePrompt(input) {
  const prompt = String(input.prompt || '');
  if (!prompt) return {};
  return { prompt: redactSecrets(prompt) };
}

function hook(event) {
  const cfg = config();
  const raw = readStdin();
  const parsed = parseJsonFromString(raw);
  const input = parsed.value || {};
  const rawBytes = Buffer.byteLength(raw);
  writeInternalLog(cfg, 'hook_start', {
    event,
    rawBytes,
    inputJson: parsed.ok,
    parseError: parsed.error || '',
  });
  try {
    const cwd = input.cwd || process.cwd();
    const gitRoot = findGitRoot(cwd);
    const now = new Date();
    const ts = now.toISOString();
    const record = {
      ts,
      tsUtc: ts,
      timeZone: cfg.timeZone,
      localDate: localDateKey(now, cfg.timeZone),
      event,
      deviceId: cfg.deviceId,
      cwd,
      gitRoot,
      gitBranch: gitRoot ? gitValue(['branch', '--show-current'], gitRoot) : '',
      sessionId: input.session_id || input.sessionId || '',
      ...parsePrompt(input),
    };
    appendEventRecord(cfg, record);
    if (input.transcript_path) rememberSessionSource(cfg, input.transcript_path);
    writeInternalLog(cfg, 'hook_success', {
      event,
      cwd,
      gitRoot,
      localDate: record.localDate,
      sessionId: record.sessionId,
    });
    if (event === 'SessionStart' && cfg.autoReport) tryScheduleReportJobs(cfg, now);
  } catch (err) {
    writeInternalLog(cfg, 'hook_error', {
      event,
      ...errorDetails(err),
    });
    throw err;
  }
}

module.exports = {
  hook,
};
