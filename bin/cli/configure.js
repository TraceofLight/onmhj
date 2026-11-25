const fs = require('fs');
const path = require('path');
const { config, configPath, reportAgentEffort, reportAgentModel } = require('./config');
const { isGitRepo } = require('./git');
const { writeInternalLog } = require('./log');
const { usage } = require('./usage');
const { localDateKey, writeJson } = require('./util');

function parseOptions(args) {
  const opts = {};
  for (const arg of args) {
    if (arg.startsWith('--prompt=')) throw new Error('prompt capture is always full');
    if (arg.startsWith('--timezone=')) opts.timeZone = arg.slice('--timezone='.length);
    if (arg.startsWith('--device-id=')) opts.deviceId = arg.slice('--device-id='.length);
    if (arg.startsWith('--owner-name=')) opts.ownerName = arg.slice('--owner-name='.length);
    if (arg.startsWith('--owner-email=')) opts.ownerEmail = arg.slice('--owner-email='.length);
    if (arg.startsWith('--auto-report=')) opts.autoReport = arg.slice('--auto-report='.length);
    if (arg.startsWith('--report-lang=')) opts.reportLanguage = arg.slice('--report-lang='.length);
    if (arg.startsWith('--report-auth=')) opts.reportAuth = arg.slice('--report-auth='.length);
    if (arg.startsWith('--report-agent=')) opts.reportAgent = arg.slice('--report-agent='.length);
    if (arg.startsWith('--report-agent-model=')) opts.reportAgentModel = arg.slice('--report-agent-model='.length);
    if (arg.startsWith('--report-agent-effort=')) opts.reportAgentEffort = arg.slice('--report-agent-effort='.length);
    if (arg.startsWith('--report-timeout-minutes=')) opts.reportTimeoutMinutes = arg.slice('--report-timeout-minutes='.length);
    if (arg.startsWith('--report-api-base=')) opts.reportApiBaseUrl = arg.slice('--report-api-base='.length);
    if (arg.startsWith('--report-model=')) opts.reportApiModel = arg.slice('--report-model='.length);
    if (arg.startsWith('--report-api-key-env=')) opts.reportApiKeyEnv = arg.slice('--report-api-key-env='.length);
    if (arg.startsWith('--report-api-key-file=')) opts.reportApiKeyFile = arg.slice('--report-api-key-file='.length);
    if (arg.startsWith('--report-api-effort=')) opts.reportApiEffort = arg.slice('--report-api-effort='.length);
    if (arg.startsWith('--report-segment-agent=')) opts.reportSegmentAgent = arg.slice('--report-segment-agent='.length);
    if (arg.startsWith('--report-revise=')) opts.reportRevise = arg.slice('--report-revise='.length);
    if (arg.startsWith('--report-pipeline=')) opts.reportPipeline = arg.slice('--report-pipeline='.length);
    if (arg.startsWith('--report-api-light-effort=')) opts.reportApiLightEffort = arg.slice('--report-api-light-effort='.length);
    if (arg.startsWith('--report-prefetch=')) opts.reportPrefetch = arg.slice('--report-prefetch='.length);
    if (arg.startsWith('--date=')) opts.date = arg.slice('--date='.length);
    if (arg.startsWith('--cwd=')) opts.cwd = arg.slice('--cwd='.length);
    if (arg.startsWith('--repo=')) opts.cwd = arg.slice('--repo='.length);
    if (arg.startsWith('--source=')) opts.source = arg.slice('--source='.length);
    if (arg.startsWith('--source-id=')) opts.sourceId = arg.slice('--source-id='.length);
    if (arg.startsWith('--session=')) opts.sessionId = arg.slice('--session='.length);
    if (arg.startsWith('--text=')) opts.text = arg.slice('--text='.length);
    if (arg.startsWith('--ts=')) opts.tsUtc = arg.slice('--ts='.length);
    if (arg.startsWith('--event=')) opts.event = arg.slice('--event='.length);
    if (arg === '--no-push') opts.noPush = true;
    if (arg === '--publish') opts.publish = true;
  }
  return opts;
}

function register(repoPath, opts) {
  if (!repoPath) throw new Error(usage());
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) throw new Error(`repo not found: ${resolved}`);
  if (!isGitRepo(resolved)) throw new Error(`not a git repo: ${resolved}`);
  validateConfigOptions(opts);
  const cfg = config();
  cfg.repoPath = resolved;
  if (opts.timeZone) cfg.timeZone = opts.timeZone;
  applyDeviceConfig(cfg, opts);
  applyOwnerConfig(cfg, opts);
  applyAutoReportConfig(cfg, opts);
  applyReportConfig(cfg, opts);
  writeJson(configPath(), cfg);
  writeInternalLog(cfg, 'register', {
    repoPath: resolved,
    timeZone: cfg.timeZone,
    deviceId: cfg.deviceId,
    ownerName: cfg.ownerName,
    ownerEmail: cfg.ownerEmail,
    autoReport: cfg.autoReport,
    reportLanguage: cfg.reportLanguage,
    reportAuth: cfg.reportAuth,
    reportAgent: cfg.reportAgent,
  });
  process.stdout.write(`registered ${resolved}\n`);
}

function validateConfigOptions(opts) {
  if (opts.timeZone) localDateKey(new Date(), opts.timeZone);
  if (opts.deviceId && !/^[A-Za-z0-9_.-]+$/.test(opts.deviceId)) {
    throw new Error('device id must contain only letters, numbers, dot, underscore, or dash');
  }
  if (opts.reportAuth && !['agent', 'api'].includes(opts.reportAuth)) {
    throw new Error('report auth must be agent or api');
  }
  if (opts.reportAgent && !['auto', 'codex', 'claude'].includes(opts.reportAgent)) {
    throw new Error('report agent must be auto, codex, or claude');
  }
  if (opts.reportAgentEffort && !['low', 'medium', 'high'].includes(opts.reportAgentEffort)) {
    throw new Error('report agent effort must be low, medium, or high');
  }
  if (opts.reportApiEffort && !['low', 'medium', 'high'].includes(opts.reportApiEffort)) {
    throw new Error('report API effort must be low, medium, or high');
  }
  if (opts.reportTimeoutMinutes && !/^[1-9]\d*$/.test(opts.reportTimeoutMinutes)) {
    throw new Error('report timeout minutes must be a positive integer');
  }
  if (opts.autoReport !== undefined && !['true', 'false'].includes(opts.autoReport)) {
    throw new Error('auto report must be true or false');
  }
  if (opts.reportApiLightEffort && !['none', 'minimal', 'low', 'medium'].includes(opts.reportApiLightEffort)) {
    throw new Error('report API light effort must be none, minimal, low, or medium');
  }
  if (opts.reportPipeline && !['summary', 'facts'].includes(opts.reportPipeline)) {
    throw new Error('report pipeline must be summary or facts');
  }
  for (const key of ['reportSegmentAgent', 'reportRevise', 'reportPrefetch']) {
    if (opts[key] !== undefined && !['true', 'false'].includes(opts[key])) throw new Error(`${key} must be true or false`);
  }
  if (opts.reportLanguage && !['en', 'ko'].includes(opts.reportLanguage)) {
    throw new Error('report language must be en or ko');
  }
  for (const key of ['reportAgentModel', 'reportApiBaseUrl', 'reportApiModel', 'reportApiKeyEnv', 'reportApiKeyFile']) {
    if (opts[key] && /[\r\n]/.test(opts[key])) throw new Error(`${key} must be a single line`);
  }
  for (const key of ['ownerName', 'ownerEmail']) {
    if (opts[key] && /[\r\n]/.test(opts[key])) throw new Error(`${key} must be a single line`);
  }
  if (opts.reportApiBaseUrl) new URL(opts.reportApiBaseUrl);
}

function applyDeviceConfig(cfg, opts) {
  if (opts.deviceId) cfg.deviceId = opts.deviceId;
}

function applyOwnerConfig(cfg, opts) {
  if (opts.ownerName) cfg.ownerName = opts.ownerName;
  if (opts.ownerEmail) cfg.ownerEmail = opts.ownerEmail;
}

function applyAutoReportConfig(cfg, opts) {
  if (opts.autoReport !== undefined) cfg.autoReport = opts.autoReport === 'true';
}

function applyReportConfig(cfg, opts) {
  if (opts.reportLanguage) cfg.reportLanguage = opts.reportLanguage;
  if (opts.reportAuth) cfg.reportAuth = opts.reportAuth;
  if (opts.reportAgent) cfg.reportAgent = opts.reportAgent;
  if (opts.reportAgentModel) cfg.reportAgentModel = opts.reportAgentModel;
  if (opts.reportAgentEffort) cfg.reportAgentEffort = opts.reportAgentEffort;
  if (opts.reportTimeoutMinutes) cfg.reportTimeoutMinutes = Number(opts.reportTimeoutMinutes);
  if (opts.reportApiBaseUrl) cfg.reportApiBaseUrl = opts.reportApiBaseUrl;
  if (opts.reportApiModel) cfg.reportApiModel = opts.reportApiModel;
  if (opts.reportApiKeyEnv) cfg.reportApiKeyEnv = opts.reportApiKeyEnv;
  if (opts.reportApiKeyFile) cfg.reportApiKeyFile = path.resolve(opts.reportApiKeyFile);
  if (opts.reportApiEffort) cfg.reportApiEffort = opts.reportApiEffort;
  if (opts.reportSegmentAgent !== undefined) cfg.reportSegmentAgent = opts.reportSegmentAgent === 'true';
  if (opts.reportRevise !== undefined) cfg.reportRevise = opts.reportRevise === 'true';
  if (opts.reportPipeline) cfg.reportPipeline = opts.reportPipeline;
  if (opts.reportApiLightEffort) cfg.reportApiLightEffort = opts.reportApiLightEffort;
  if (opts.reportPrefetch !== undefined) cfg.reportPrefetch = opts.reportPrefetch === 'true';
}

function configure(opts) {
  validateConfigOptions(opts);
  if (!opts.timeZone && !opts.deviceId && !opts.ownerName && !opts.ownerEmail && opts.autoReport === undefined && !opts.reportLanguage && !opts.reportAuth && !opts.reportAgent && !opts.reportAgentModel && !opts.reportAgentEffort && !opts.reportTimeoutMinutes && !opts.reportApiBaseUrl && !opts.reportApiModel && !opts.reportApiKeyEnv && !opts.reportApiKeyFile && !opts.reportApiEffort && opts.reportSegmentAgent === undefined && opts.reportRevise === undefined && !opts.reportPipeline && !opts.reportApiLightEffort && opts.reportPrefetch === undefined) {
    throw new Error(usage());
  }
  const cfg = config();
  if (opts.timeZone) cfg.timeZone = opts.timeZone;
  applyDeviceConfig(cfg, opts);
  applyOwnerConfig(cfg, opts);
  applyAutoReportConfig(cfg, opts);
  applyReportConfig(cfg, opts);
  writeJson(configPath(), cfg);
  writeInternalLog(cfg, 'config', {
    timeZone: cfg.timeZone,
    deviceId: cfg.deviceId,
    ownerName: cfg.ownerName,
    ownerEmail: cfg.ownerEmail,
    autoReport: cfg.autoReport,
    reportLanguage: cfg.reportLanguage,
    reportAuth: cfg.reportAuth,
    reportAgent: cfg.reportAgent,
    reportAgentModel: cfg.reportAgentModel,
    reportAgentEffort: cfg.reportAgentEffort,
    reportTimeoutMinutes: cfg.reportTimeoutMinutes,
  });
  process.stdout.write(`configured timeZone=${cfg.timeZone} deviceId=${cfg.deviceId} autoReport=${cfg.autoReport} reportLanguage=${cfg.reportLanguage} reportAuth=${cfg.reportAuth} reportAgent=${cfg.reportAgent} reportAgentModel=${cfg.reportAgentModel || '(default)'} reportAgentEffort=${cfg.reportAgentEffort} reportTimeoutMinutes=${cfg.reportTimeoutMinutes}\n`);
}

module.exports = {
  configure,
  parseOptions,
  register,
};
