const os = require('os');
const path = require('path');
const { globalGitConfig } = require('./git');
const { normalizeTimeZone, readJson } = require('./util');

let CONFIG_PATH = process.env.ONMHJ_CONFIG || path.join(os.homedir(), '.config', 'onmhj', 'config.json');
const ENTRY_FILE = path.join(__dirname, '..', 'onmhj.js');
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'onmhj');
const DEFAULT_REPORT_API_KEY_ENV = 'ONMHJ_LLM_API_KEY';

const DEFAULT_REPORT_AGENT_EFFORT = 'medium';
const DEFAULT_REPORT_TIMEOUT_MINUTES = 15;
const DEFAULT_REPORT_AGENT_MODELS = {
  claude: 'sonnet',
  codex: 'gpt-5.6-terra',
};

function config() {
  const cfg = readJson(configPath(), {});
  return {
    stateDir: cfg.stateDir || DEFAULT_STATE_DIR,
    repoPath: cfg.repoPath || '',
    timeZone: normalizeTimeZone(cfg.timeZone),
    deviceId: cfg.deviceId || defaultDeviceId(),
    ownerName: cfg.ownerName || globalGitConfig('user.name') || os.userInfo().username,
    ownerEmail: cfg.ownerEmail || globalGitConfig('user.email') || '',
    autoReport: cfg.autoReport !== false,
    reportLanguage: cfg.reportLanguage || userLanguage(),
    reportAuth: cfg.reportAuth || 'agent',
    reportAgent: cfg.reportAgent || 'auto',
    reportAgentModel: cfg.reportAgentModel || '',
    reportAgentEffort: cfg.reportAgentEffort || DEFAULT_REPORT_AGENT_EFFORT,
    reportTimeoutMinutes: cfg.reportTimeoutMinutes || DEFAULT_REPORT_TIMEOUT_MINUTES,
    reportApiBaseUrl: cfg.reportApiBaseUrl || '',
    reportApiModel: cfg.reportApiModel || '',
    reportApiKeyEnv: cfg.reportApiKeyEnv || DEFAULT_REPORT_API_KEY_ENV,
    reportApiKeyFile: cfg.reportApiKeyFile || '',
    reportApiEffort: cfg.reportApiEffort || '',
    reportSegmentAgent: cfg.reportSegmentAgent === true,
    reportRevise: cfg.reportRevise === true,
    reportPipeline: cfg.reportPipeline === 'facts' ? 'facts' : 'summary',
    reportApiLightEffort: cfg.reportApiLightEffort || '',
    reportPrefetch: cfg.reportPrefetch === true,
  };
}

function userLanguage() {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return String(locale).toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function defaultDeviceId() {
  return String(os.hostname() || os.userInfo().username || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function nativeAgentProvider(cfg, env = process.env) {
  if (cfg.reportAgent && cfg.reportAgent !== 'auto') return cfg.reportAgent;
  return env.CLAUDE_PLUGIN_ROOT ? 'claude' : 'codex';
}

function reportAgentModel(cfg, provider) {
  return cfg.reportAgentModel || DEFAULT_REPORT_AGENT_MODELS[provider];
}

function reportAgentEffort(cfg) {
  return cfg.reportAgentEffort || DEFAULT_REPORT_AGENT_EFFORT;
}

function reportBackendTimeoutMs(cfg) {
  return (cfg.reportTimeoutMinutes || DEFAULT_REPORT_TIMEOUT_MINUTES) * 60 * 1000;
}

function configPath() {
  return CONFIG_PATH;
}

function setConfigPath(file) {
  CONFIG_PATH = file;
}

module.exports = {
  DEFAULT_REPORT_API_KEY_ENV,
  ENTRY_FILE,
  config,
  configPath,
  nativeAgentProvider,
  reportAgentEffort,
  reportAgentModel,
  reportBackendTimeoutMs,
  setConfigPath,
};
