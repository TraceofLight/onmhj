#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

let CONFIG_PATH = process.env.ONMHJ_CONFIG || path.join(os.homedir(), '.config', 'onmhj', 'config.json');
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'onmhj');
const DEFAULT_REPORT_API_KEY_ENV = 'ONMHJ_LLM_API_KEY';
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function usage() {
  return [
    'Usage:',
    '  onmhj hook <event>',
    '  onmhj register <git-repo-path> [--prompt=preview|full|off] [--timezone=Area/City] [--device-id=ID] [--owner-name=NAME] [--owner-email=EMAIL] [--report-lang=en|ko] [--report-auth=agent|api]',
    '  onmhj config [--prompt=preview|full|off] [--timezone=Area/City] [--device-id=ID] [--owner-name=NAME] [--owner-email=EMAIL] [--report-lang=en|ko] [--report-auth=agent|api] [--report-api-base=URL] [--report-model=MODEL] [--report-api-key-env=NAME]',
    '  onmhj inject --text=TEXT [--date=YYYY-MM-DD] [--cwd=PATH] [--source=NAME] [--source-id=ID]',
    '  onmhj import <events.jsonl>',
    '  onmhj flush [YYYY-MM-DD] [--no-push]',
    '  onmhj ejmhj [YYYY-MM-DD] [--no-push]',
    '  onmhj worker',
    '  onmhj status',
    '  onmhj selftest',
  ].join('\n');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function config() {
  const cfg = readJson(CONFIG_PATH, {});
  return {
    stateDir: cfg.stateDir || DEFAULT_STATE_DIR,
    repoPath: cfg.repoPath || '',
    promptMode: cfg.promptMode || 'preview',
    timeZone: normalizeTimeZone(cfg.timeZone),
    deviceId: cfg.deviceId || defaultDeviceId(),
    ownerName: cfg.ownerName || globalGitConfig('user.name') || os.userInfo().username,
    ownerEmail: cfg.ownerEmail || globalGitConfig('user.email') || '',
    reportLanguage: cfg.reportLanguage || userLanguage(),
    reportAuth: cfg.reportAuth || 'agent',
    reportApiBaseUrl: cfg.reportApiBaseUrl || '',
    reportApiModel: cfg.reportApiModel || '',
    reportApiKeyEnv: cfg.reportApiKeyEnv || DEFAULT_REPORT_API_KEY_ENV,
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

function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function normalizeTimeZone(timeZone) {
  const value = timeZone || systemTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return systemTimeZone();
  }
}

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function localDateKey(date = new Date(), timeZone = systemTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function previousLocalDateKey(date = new Date(), timeZone = systemTimeZone()) {
  return localDateKey(new Date(date.getTime() - 24 * 60 * 60 * 1000), timeZone);
}

function eventFile(cfg, date = utcDateKey()) {
  return path.join(cfg.stateDir, 'events', date + '.jsonl');
}

function internalLogFile(cfg, date = utcDateKey()) {
  return path.join(cfg.stateDir, 'internal', date + '.jsonl');
}

function workerLogFile(cfg) {
  return path.join(cfg.stateDir, 'worker.log');
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.replace(/\n$/, '') + '\n', { mode: 0o600 });
}

function writeInternalLog(cfg, action, data = {}) {
  const now = new Date();
  try {
    appendLine(internalLogFile(cfg, utcDateKey(now)), JSON.stringify({
      ts: now.toISOString(),
      action,
      ...data,
    }));
  } catch {
    // Internal logs are best-effort and must never break hooks.
  }
}

function errorDetails(err) {
  return {
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? String(err.stack) : '',
  };
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function run(cmd, args, cwd, allowFail = false) {
  const out = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFail && out.status !== 0) {
    throw new Error((out.stderr || out.stdout || `${cmd} failed`).trim());
  }
  return out;
}

function gitValue(args, cwd) {
  const out = run('git', args, cwd, true);
  return out.status === 0 ? out.stdout.trim() : '';
}

function globalGitConfig(key) {
  return gitValue(['config', '--global', '--get', key], process.cwd());
}

function findGitRoot(cwd) {
  return gitValue(['rev-parse', '--show-toplevel'], cwd);
}

function isGitRepo(dir) {
  return Boolean(findGitRoot(dir));
}

function parsePrompt(input, mode) {
  if (mode === 'off') return {};
  const prompt = String(input.prompt || '');
  if (!prompt) return {};
  if (mode === 'full') return { prompt: redactSecrets(prompt) };
  return { promptPreview: redactSecrets(prompt).slice(0, 300) };
}

function redactSecrets(value) {
  return String(value)
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|SG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|private[_-]?key)\b(\s*[:=]\s*)(['"]?)[^\s'"`,;]+/gi, (_match, key, sep, quote) => `${key}${sep}${quote}[REDACTED]`);
}

function sanitizeEvent(event) {
  const clean = { ...event };
  if (clean.prompt) clean.prompt = redactSecrets(clean.prompt);
  if (clean.promptPreview) clean.promptPreview = redactSecrets(clean.promptPreview);
  return clean;
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
      ...parsePrompt(input, cfg.promptMode),
    };
    appendLine(eventFile(cfg, utcDateKey(now)), JSON.stringify(record));
    writeInternalLog(cfg, 'hook_success', {
      event,
      cwd,
      gitRoot,
      localDate: record.localDate,
      sessionId: record.sessionId,
    });
    if (event === 'SessionStart') tryScheduleReportJobs(cfg, now);
  } catch (err) {
    writeInternalLog(cfg, 'hook_error', {
      event,
      ...errorDetails(err),
    });
    throw err;
  }
}

function readJsonFromString(raw, fallback) {
  const parsed = parseJsonFromString(raw);
  return parsed.ok ? parsed.value : fallback;
}

function parseJsonFromString(raw) {
  try {
    return { ok: true, value: JSON.parse(String(raw || '').replace(/^\uFEFF/, '')) };
  } catch (err) {
    return { ok: false, value: null, error: err && err.message ? err.message : String(err) };
  }
}

function parseOptions(args) {
  const opts = {};
  for (const arg of args) {
    if (arg.startsWith('--prompt=')) opts.promptMode = arg.slice('--prompt='.length);
    if (arg.startsWith('--timezone=')) opts.timeZone = arg.slice('--timezone='.length);
    if (arg.startsWith('--device-id=')) opts.deviceId = arg.slice('--device-id='.length);
    if (arg.startsWith('--owner-name=')) opts.ownerName = arg.slice('--owner-name='.length);
    if (arg.startsWith('--owner-email=')) opts.ownerEmail = arg.slice('--owner-email='.length);
    if (arg.startsWith('--report-lang=')) opts.reportLanguage = arg.slice('--report-lang='.length);
    if (arg.startsWith('--report-auth=')) opts.reportAuth = arg.slice('--report-auth='.length);
    if (arg.startsWith('--report-api-base=')) opts.reportApiBaseUrl = arg.slice('--report-api-base='.length);
    if (arg.startsWith('--report-model=')) opts.reportApiModel = arg.slice('--report-model='.length);
    if (arg.startsWith('--report-api-key-env=')) opts.reportApiKeyEnv = arg.slice('--report-api-key-env='.length);
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
  if (opts.promptMode) cfg.promptMode = opts.promptMode;
  if (opts.timeZone) cfg.timeZone = opts.timeZone;
  applyDeviceConfig(cfg, opts);
  applyOwnerConfig(cfg, opts);
  applyReportConfig(cfg, opts);
  writeJson(CONFIG_PATH, cfg);
  writeInternalLog(cfg, 'register', {
    repoPath: resolved,
    promptMode: cfg.promptMode,
    timeZone: cfg.timeZone,
    deviceId: cfg.deviceId,
    ownerName: cfg.ownerName,
    ownerEmail: cfg.ownerEmail,
    reportLanguage: cfg.reportLanguage,
    reportAuth: cfg.reportAuth,
  });
  process.stdout.write(`registered ${resolved}\n`);
}

function validateConfigOptions(opts) {
  if (opts.promptMode && !['preview', 'full', 'off'].includes(opts.promptMode)) {
    throw new Error('prompt mode must be preview, full, or off');
  }
  if (opts.timeZone) localDateKey(new Date(), opts.timeZone);
  if (opts.deviceId && !/^[A-Za-z0-9_.-]+$/.test(opts.deviceId)) {
    throw new Error('device id must contain only letters, numbers, dot, underscore, or dash');
  }
  if (opts.reportAuth && !['agent', 'api'].includes(opts.reportAuth)) {
    throw new Error('report auth must be agent or api');
  }
  if (opts.reportLanguage && !['en', 'ko'].includes(opts.reportLanguage)) {
    throw new Error('report language must be en or ko');
  }
  for (const key of ['reportApiBaseUrl', 'reportApiModel', 'reportApiKeyEnv']) {
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

function applyReportConfig(cfg, opts) {
  if (opts.reportLanguage) cfg.reportLanguage = opts.reportLanguage;
  if (opts.reportAuth) cfg.reportAuth = opts.reportAuth;
  if (opts.reportApiBaseUrl) cfg.reportApiBaseUrl = opts.reportApiBaseUrl;
  if (opts.reportApiModel) cfg.reportApiModel = opts.reportApiModel;
  if (opts.reportApiKeyEnv) cfg.reportApiKeyEnv = opts.reportApiKeyEnv;
}

function reportRuntime(cfg) {
  if (cfg.reportAuth === 'api') {
    return {
      auth: 'api',
      baseUrl: cfg.reportApiBaseUrl,
      model: cfg.reportApiModel,
      apiKeyEnv: cfg.reportApiKeyEnv,
      hasApiKey: Boolean(process.env[cfg.reportApiKeyEnv]),
    };
  }
  return {
    auth: 'agent',
    description: 'Use the active Codex/Claude Code session auth for daily report generation.',
  };
}

function configure(opts) {
  validateConfigOptions(opts);
  if (!opts.promptMode && !opts.timeZone && !opts.deviceId && !opts.ownerName && !opts.ownerEmail && !opts.reportLanguage && !opts.reportAuth && !opts.reportApiBaseUrl && !opts.reportApiModel && !opts.reportApiKeyEnv) {
    throw new Error(usage());
  }
  const cfg = config();
  if (opts.promptMode) cfg.promptMode = opts.promptMode;
  if (opts.timeZone) cfg.timeZone = opts.timeZone;
  applyDeviceConfig(cfg, opts);
  applyOwnerConfig(cfg, opts);
  applyReportConfig(cfg, opts);
  writeJson(CONFIG_PATH, cfg);
  writeInternalLog(cfg, 'config', {
    promptMode: cfg.promptMode,
    timeZone: cfg.timeZone,
    deviceId: cfg.deviceId,
    ownerName: cfg.ownerName,
    ownerEmail: cfg.ownerEmail,
    reportLanguage: cfg.reportLanguage,
    reportAuth: cfg.reportAuth,
  });
  process.stdout.write(`configured prompt=${cfg.promptMode} timeZone=${cfg.timeZone} deviceId=${cfg.deviceId} reportLanguage=${cfg.reportLanguage} reportAuth=${cfg.reportAuth}\n`);
}

function eventDedupeKey(event) {
  if (event.sourceId) return `sourceId:${event.sourceId}`;
  return [
    'event',
    event.tsUtc || event.ts || '',
    event.event || '',
    event.sessionId || '',
    event.deviceId || '',
    event.cwd || '',
    event.prompt || event.promptPreview || '',
  ].join(':');
}

function appendEventRecord(cfg, event) {
  const file = eventFile(cfg, utcDateKey(new Date(event.tsUtc || event.ts)));
  const key = eventDedupeKey(event);
  if (key && loadEvents(file).some(existing => eventDedupeKey(existing) === key)) return false;
  appendLine(file, JSON.stringify(event));
  return true;
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
  if (raw.promptPreview) event.promptPreview = redactSecrets(raw.promptPreview).slice(0, 300);
  if (!event.prompt && !event.promptPreview && raw.text) {
    event.promptPreview = redactSecrets(raw.text).slice(0, 300);
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
    if (appendEventRecord(cfg, normalizeImportedEvent(parsed.value, cfg))) added += 1;
    else skipped += 1;
  }
  writeInternalLog(cfg, 'import', { file, added, skipped });
  process.stdout.write(`imported ${added}, skipped ${skipped}\n`);
}

function reportJobsDir(cfg) {
  return path.join(cfg.stateDir, 'jobs', 'reports');
}

function localConfirmationFile(cfg) {
  return path.join(reportJobsDir(cfg), 'confirmed.json');
}

function deviceConfirmationDir(cfg) {
  return path.join(cfg.repoPath, 'state', 'devices');
}

function deviceConfirmationFile(cfg, deviceId = cfg.deviceId) {
  return path.join(deviceConfirmationDir(cfg), deviceId + '.json');
}

function reportJobFile(cfg, date) {
  return path.join(reportJobsDir(cfg), date + '.json');
}

function reportJobLockFile(cfg, date) {
  return path.join(reportJobsDir(cfg), date + '.lock');
}

function workerLockFile(cfg) {
  return path.join(reportJobsDir(cfg), 'worker.lock');
}

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
  writeJson(localConfirmationFile(cfg), {
    deviceId: cfg.deviceId,
    confirmedThrough,
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
  writeJson(target, {
    deviceId: cfg.deviceId,
    confirmedThrough,
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readJson(file, null);
  const stale = existing && existing.ts && Date.now() - Date.parse(existing.ts) > LOCK_STALE_MS;
  if (existing && (stale || (existing.pid && !pidAlive(existing.pid)))) {
    try { fs.unlinkSync(file); } catch {}
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }) + '\n', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(file) {
  try { fs.unlinkSync(file); } catch {}
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

function hasValidReport(cfg, date) {
  try {
    validateReport(fs.readFileSync(path.join(cfg.repoPath, 'reports', date + '.md'), 'utf8'), date);
    return true;
  } catch {
    return false;
  }
}

function shouldScheduleReportDate(cfg, date, state) {
  if (!hasValidReport(cfg, date)) return true;
  if (!state.localConfirmedThrough || date > state.localConfirmedThrough) return true;
  return Boolean(state.remoteConfirmedFloor && date > state.remoteConfirmedFloor);
}

function tryScheduleReportJobs(cfg, now = new Date(), opts = {}) {
  const state = reportScheduleState(cfg, now);
  // The floor is intentionally the minimum across devices; a late device can
  // lower it so merged reports are regenerated from the earliest uncertain day.
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
  const child = childProcess.spawn(process.execPath, [__filename, 'worker'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ONMHJ_CONFIG: CONFIG_PATH },
  });
  child.unref();
  fs.closeSync(out);
}

function loadEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => readJsonFromString(line, null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mergeEvents(...groups) {
  const seen = new Set();
  const merged = [];
  for (const event of groups.flat()) {
    const clean = sanitizeEvent(event);
    const key = eventDedupeKey(clean);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(clean);
  }
  return merged.sort((a, b) => String(a.tsUtc || a.ts).localeCompare(String(b.tsUtc || b.ts)));
}

function loadEventsForLocalDate(cfg, date) {
  const dir = path.join(cfg.stateDir, 'events');
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .map(file => path.join(dir, file));
  } catch {
    return [];
  }
  return files
    .flatMap(loadEvents)
    .filter(event => event.localDate === date || (!event.localDate && utcDateKey(new Date(event.ts)) === date))
    .map(sanitizeEvent)
    .sort((a, b) => String(a.tsUtc || a.ts).localeCompare(String(b.tsUtc || b.ts)));
}

const REPORT_SECTIONS = ['요약', '작업 이유', '작업 과정', '결정 사항', '도출 결과', '남은 일'];

function buildReportPrompt(date, daily, raw) {
  return [
    `${date} 작업일의 최종보고서를 한국어 Markdown으로 작성하라.`,
    '확인되지 않은 작업을 지어내지 말고 제공된 근거만 사용하라.',
    `첫 줄은 정확히 \`# ${date} 어제 뭐 했지\`로 작성하라.`,
    `필수 섹션을 순서대로 작성하라: ${REPORT_SECTIONS.map(section => `## ${section}`).join(', ')}`,
    '확인된 내용이 없는 섹션에는 `- 확인된 내용 없음`을 작성하라.',
    'Markdown 본문만 출력하라.',
    '',
    '--- daily evidence ---',
    daily,
    '--- normalized raw events ---',
    raw,
  ].join('\n');
}

function validateReport(value, date) {
  const report = String(value || '').trim() + '\n';
  if (!report.startsWith(`# ${date} 어제 뭐 했지\n`)) {
    throw new Error(`report heading must match work date ${date}`);
  }
  for (const section of REPORT_SECTIONS) {
    if (!report.includes(`\n## ${section}\n`)) throw new Error(`report missing section: ${section}`);
  }
  return report;
}

function runAgent(command, args, input) {
  return childProcess.spawnSync(command, args, { input, encoding: 'utf8' });
}

async function requestApi(url, options, body, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...options, body: JSON.stringify(body) });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    if (!response.ok) throw new Error(`report API failed: HTTP ${response.status}: ${text || 'empty response'}`);
    throw new Error('report API returned invalid JSON');
  }
  if (!response.ok) {
    const message = value && value.error && value.error.message ? value.error.message : `HTTP ${response.status}`;
    throw new Error(`report API failed: ${message}`);
  }
  return value;
}

async function generateReport(cfg, date, daily, raw, deps = {}) {
  const prompt = buildReportPrompt(date, daily, raw);
  let output;
  if (cfg.reportAuth === 'api') {
    if (!cfg.reportApiBaseUrl) throw new Error('report API base URL is required');
    if (!cfg.reportApiModel) throw new Error('report API model is required');
    const env = deps.env || process.env;
    const apiKey = env[cfg.reportApiKeyEnv || DEFAULT_REPORT_API_KEY_ENV];
    if (!apiKey) throw new Error(`report API key is missing: ${cfg.reportApiKeyEnv || DEFAULT_REPORT_API_KEY_ENV}`);
    const callApi = deps.requestApi || requestApi;
    const result = await callApi(
      cfg.reportApiBaseUrl.replace(/\/$/, '') + '/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      },
      { model: cfg.reportApiModel, messages: [{ role: 'user', content: prompt }] },
    );
    output = result && result.choices && result.choices[0] && result.choices[0].message
      ? result.choices[0].message.content
      : '';
  } else {
    const callAgent = deps.runAgent || runAgent;
    const command = process.platform === 'win32' ? 'cmd.exe' : 'codex';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'codex.cmd exec --ignore-user-config --ephemeral --skip-git-repo-check -']
      : ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-'];
    const result = callAgent(command, args, prompt);
    if (!result || result.status !== 0) {
      const detail = result && (result.stderr || result.stdout || (result.error && result.error.message));
      throw new Error(`report agent failed: ${detail || 'unknown error'}`.trim());
    }
    output = result.stdout;
  }
  return validateReport(output, date);
}

function reportLabels(language) {
  if (language === 'ko') {
    return {
      title: 'AI 작업 기록',
      timeZone: '시간대',
      timeline: '타임라인: UTC timestamps',
      events: '이벤트',
      devices: '장치',
      repositories: '저장소',
      prompts: '프롬프트',
      more: count => `... ${count}개 더`,
    };
  }
  return {
    title: 'AI worklog',
    timeZone: 'Time zone',
    timeline: 'Timeline: UTC timestamps',
    events: 'Events',
    devices: 'Devices',
    repositories: 'Repositories',
    prompts: 'Prompts',
    more: count => `... ${count} more`,
  };
}

function summarize(events, date, language = 'en') {
  const labels = reportLabels(language);
  const byRepo = new Map();
  const byDevice = new Map();
  for (const event of events) {
    const device = event.deviceId || 'unknown';
    byDevice.set(device, (byDevice.get(device) || 0) + 1);

    const key = event.gitRoot || event.cwd || '(unknown)';
    const row = byRepo.get(key) || { count: 0, prompts: [] };
    row.count += 1;
    const prompt = event.prompt || event.promptPreview;
    if (prompt) row.prompts.push(prompt.replace(/\s+/g, ' ').trim());
    byRepo.set(key, row);
  }

  const lines = [
    `# ${date} ${labels.title}`,
    '',
    `${labels.timeZone}: ${events[0] && events[0].timeZone ? events[0].timeZone : 'unknown'}`,
    labels.timeline,
    '',
    `${labels.events}: ${events.length}`,
    '',
    `## ${labels.devices}`,
    '',
  ];
  for (const [device, count] of byDevice.entries()) {
    lines.push(`- ${device}: ${count}`);
  }
  lines.push(
    '',
    `## ${labels.repositories}`,
    '',
  );
  for (const [repo, row] of byRepo.entries()) {
    lines.push(`### ${repo}`, '', `${labels.events}: ${row.count}`, '');
    if (row.prompts.length) {
      lines.push(`${labels.prompts}:`, '');
      for (const prompt of row.prompts.slice(0, 50)) lines.push(`- ${prompt}`);
      if (row.prompts.length > 50) lines.push(`- ${labels.more(row.prompts.length - 50)}`);
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function syncReportRepo(repoPath) {
  const upstream = gitValue(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath);
  if (!upstream) return false;
  run('git', ['pull', '--rebase', '--autostash'], repoPath);
  return true;
}

function prepareDaily(cfg, key, opts = {}) {
  const pulled = opts.pull === false ? false : syncReportRepo(cfg.repoPath);
  const rawTarget = path.join(cfg.repoPath, 'raw', 'ai-sessions', key + '.jsonl');
  const dailyTarget = path.join(cfg.repoPath, 'daily', key + '.md');
  const events = mergeEvents(loadEvents(rawTarget), loadEventsForLocalDate(cfg, key));
  if (!events.length) return null;
  fs.mkdirSync(path.dirname(rawTarget), { recursive: true });
  fs.mkdirSync(path.dirname(dailyTarget), { recursive: true });
  const raw = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  const daily = summarize(events, key, cfg.reportLanguage);
  fs.writeFileSync(rawTarget, raw);
  fs.writeFileSync(dailyTarget, daily);
  return { daily, dailyTarget, eventCount: events.length, pulled, raw, rawTarget };
}

function commitArtifacts(cfg, key, targets, opts = {}) {
  run('git', ['add', ...targets], cfg.repoPath);
  const diff = run('git', ['diff', '--cached', '--quiet'], cfg.repoPath, true);
  if (diff.status !== 0) run('git', ['commit', '-m', `log: ${key} AI worklog`], cfg.repoPath);
  if (!opts.noPush) run('git', ['push'], cfg.repoPath);
  return diff.status !== 0;
}

function flush(date, opts) {
  const cfg = config();
  if (!cfg.repoPath) throw new Error('run `onmhj register <git-repo-path>` first');
  if (!isGitRepo(cfg.repoPath)) throw new Error(`registered path is not a git repo: ${cfg.repoPath}`);

  const key = date || localDateKey(new Date(), cfg.timeZone);
  const prepared = prepareDaily(cfg, key);
  if (!prepared) {
    writeInternalLog(cfg, 'flush_no_events', { date: key });
    process.stdout.write(`no events for ${key}\n`);
    return;
  }
  const changed = commitArtifacts(cfg, key, [prepared.rawTarget, prepared.dailyTarget], opts);
  writeInternalLog(cfg, 'flush', {
    date: key,
    eventCount: prepared.eventCount,
    deviceId: cfg.deviceId,
    rawTarget: prepared.rawTarget,
    dailyTarget: prepared.dailyTarget,
    pulled: prepared.pulled,
    pushed: !opts.noPush,
  });
  process.stdout.write(`${changed ? 'flushed' : 'no git changes for'} ${key}\n`);
}

async function runFullReport(cfg, date, opts = {}) {
  if (!cfg.repoPath) throw new Error('run `onmhj register <git-repo-path>` first');
  if (!isGitRepo(cfg.repoPath)) throw new Error(`registered path is not a git repo: ${cfg.repoPath}`);
  const prepared = prepareDaily(cfg, date);
  if (!prepared) throw new Error(`no events for ${date}`);
  const createReport = opts.generateReport || generateReport;
  const report = validateReport(await createReport(cfg, date, prepared.daily, prepared.raw), date);
  const reportTarget = path.join(cfg.repoPath, 'reports', date + '.md');
  fs.mkdirSync(path.dirname(reportTarget), { recursive: true });
  fs.writeFileSync(reportTarget, report);
  const confirmTarget = writeDeviceConfirmation(cfg, date);
  commitArtifacts(
    cfg,
    date,
    [prepared.rawTarget, prepared.dailyTarget, reportTarget, confirmTarget],
    opts,
  );
  writeLocalConfirmation(cfg, date);
  writeInternalLog(cfg, 'report', {
    date,
    eventCount: prepared.eventCount,
    rawTarget: prepared.rawTarget,
    dailyTarget: prepared.dailyTarget,
    reportTarget,
    confirmTarget,
    pulled: prepared.pulled,
    pushed: !opts.noPush,
  });
  process.stdout.write(`reported ${date}\n`);
  return reportTarget;
}

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
      await runFullReport(cfg, date, opts);
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

async function processReportJobs(cfg) {
  try {
    if (cfg.repoPath && isGitRepo(cfg.repoPath)) syncReportRepo(cfg.repoPath);
  } catch (err) {
    writeInternalLog(cfg, 'report_repo_sync_failed', errorDetails(err));
  }
  tryScheduleReportJobs(cfg, new Date(), { spawn: false });
  const now = Date.now();
  // Confirmed dates must advance contiguously. Stop at the first incomplete
  // date so a later success cannot hide an earlier failed report.
  for (const job of listReportJobs(cfg)) {
    if (job.status === 'completed') continue;
    const due = Date.parse(job.nextAttemptAt || job.createdAt || new Date().toISOString());
    if (!Number.isNaN(due) && due > now) {
      break;
    }
    if (!await runReportJob(cfg, job.date)) break;
  }
  for (const job of listReportJobs(cfg)) {
    if (job.status === 'completed') continue;
    const due = Date.parse(job.nextAttemptAt || new Date().toISOString());
    return Number.isNaN(due) ? 0 : Math.max(0, due - Date.now());
  }
  return 0;
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
    `config: ${CONFIG_PATH}`,
    `state: ${cfg.stateDir}`,
    `internalLog: ${logFile}`,
    `workerLog: ${workerLogFile(cfg)}`,
    `repo: ${cfg.repoPath || '(not registered)'}`,
    `prompt: ${cfg.promptMode}`,
    `timeZone: ${cfg.timeZone}`,
    `deviceId: ${cfg.deviceId}`,
    `ownerName: ${cfg.ownerName}`,
    `ownerEmail: ${cfg.ownerEmail || '(unset)'}`,
    `reportLanguage: ${cfg.reportLanguage}`,
    `reportAuth: ${report.auth}`,
    `reportApiBase: ${cfg.reportApiBaseUrl || '(unset)'}`,
    `reportModel: ${cfg.reportApiModel || '(unset)'}`,
    `reportApiKeyEnv: ${cfg.reportApiKeyEnv}`,
    `confirmedThrough: ${localConfirmed}`,
    `confirmedFloor: ${floor}`,
    `reportJobs: pending=${jobs.filter(job => job.status === 'pending').length} running=${jobs.filter(job => job.status === 'running').length} failed=${jobs.filter(job => job.status === 'failed').length} completed=${jobs.filter(job => job.status === 'completed').length}`,
    `todayEvents: ${events.length}`,
  ].join('\n') + '\n');
}

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-'));
  const originalConfigPath = CONFIG_PATH;
  CONFIG_PATH = path.join(tmp, 'config.json');
  try {
  const repo = path.join(tmp, 'repo');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(repo);
  run('git', ['init'], repo);
  run('git', ['config', 'user.email', 'onmhj@example.local'], repo);
  run('git', ['config', 'user.name', 'onmhj'], repo);
  writeJson(CONFIG_PATH, { repoPath: repo, stateDir: state, promptMode: 'preview', timeZone: 'Asia/Seoul', reportLanguage: 'ko' });
  const existingRaw = path.join(repo, 'raw', 'ai-sessions', '2026-07-09.jsonl');
  fs.mkdirSync(path.dirname(existingRaw), { recursive: true });
  fs.writeFileSync(existingRaw, JSON.stringify({
    ts: '2026-07-09T00:30:00.000Z',
    tsUtc: '2026-07-09T00:30:00.000Z',
    timeZone: 'Asia/Seoul',
    localDate: '2026-07-09',
    event: 'UserPromptSubmit',
    deviceId: 'other-device',
    cwd: repo,
    gitRoot: repo,
    promptPreview: 'other device work',
  }) + '\n');
  appendLine(eventFile(config(), '2026-07-08'), JSON.stringify({
    ts: '2026-07-08T15:00:00.000Z',
    tsUtc: '2026-07-08T15:00:00.000Z',
    timeZone: 'Asia/Seoul',
    localDate: '2026-07-09',
    event: 'UserPromptSubmit',
    cwd: repo,
    gitRoot: repo,
    promptPreview: 'test work token=redaction-fixture-value',
  }));
  appendLine(eventFile(config(), '2026-07-09'), JSON.stringify({
    ts: '2026-07-09T15:00:00.000Z',
    tsUtc: '2026-07-09T15:00:00.000Z',
    timeZone: 'Asia/Seoul',
    localDate: '2026-07-10',
    event: 'UserPromptSubmit',
    cwd: repo,
    gitRoot: repo,
    promptPreview: 'next day work',
  }));
  flush('2026-07-09', { noPush: true });
  const daily = fs.readFileSync(path.join(repo, 'daily', '2026-07-09.md'), 'utf8');
  const raw = fs.readFileSync(path.join(repo, 'raw', 'ai-sessions', '2026-07-09.jsonl'), 'utf8');
  if (!daily) throw new Error('daily file missing');
  if (!daily.includes('## 장치')) throw new Error('localized device summary missing');
  if (!raw.includes('"deviceId":"other-device"')) throw new Error('existing raw event was not preserved');
  if (daily.includes('redaction-fixture-value') || raw.includes('redaction-fixture-value')) {
    throw new Error('secret redaction failed');
  }
  tryScheduleReportJobs(config(), new Date('2026-07-11T00:00:00.000Z'), { spawn: false });
  const queuedDates = listReportJobs(config()).map(item => item.date);
  if (!queuedDates.includes('2026-07-09') || !queuedDates.includes('2026-07-10')) {
    throw new Error('unconfirmed report dates were not queued');
  }
  const createSelftestReport = async (_cfg, date) => validateReport([
    `# ${date} 어제 뭐 했지`,
    '',
    ...REPORT_SECTIONS.flatMap(section => [`## ${section}`, '- selftest', '']),
  ].join('\n'), date);
  await runReportJob(config(), '2026-07-09', { noPush: true, generateReport: createSelftestReport });
  await runReportJob(config(), '2026-07-10', { noPush: true, generateReport: createSelftestReport });
  const job = readReportJob(config(), '2026-07-09');
  if (!job || job.status !== 'completed') throw new Error('report job did not complete');
  const confirmed = readLocalConfirmation(config()).confirmedThrough;
  if (confirmed !== '2026-07-10') throw new Error('local confirmation did not advance');
  const deviceConfirmed = readJson(deviceConfirmationFile(config()), {});
  if (deviceConfirmed.confirmedThrough !== '2026-07-10') throw new Error('device confirmation did not advance');
  writeJson(deviceConfirmationFile(config(), 'other-device'), {
    deviceId: 'other-device',
    confirmedThrough: '2026-07-08',
    updatedAt: new Date().toISOString(),
  });
  tryScheduleReportJobs(config(), new Date('2026-07-11T00:00:00.000Z'), { spawn: false });
  if (readReportJob(config(), '2026-07-09').status !== 'pending') {
    throw new Error('lower remote confirmation did not requeue completed report');
  }
  writeReportJob(config(), {
    ...readReportJob(config(), '2026-07-09'),
    status: 'failed',
    nextAttemptAt: '2999-01-01T00:00:00.000Z',
  });
  const blockedDelay = await processReportJobs(config());
  const blockedNextJob = readReportJob(config(), '2026-07-10');
  if (blockedDelay <= 0) throw new Error('worker did not wait for earliest retry');
  if (!blockedNextJob || blockedNextJob.status !== 'pending' || blockedNextJob.attempts !== 1) {
    throw new Error('later report ran before earlier retry was due');
  }
  const hookRun = childProcess.spawnSync(process.execPath, [__filename, 'hook', 'UserPromptSubmit'], {
    env: { ...process.env, ONMHJ_CONFIG: CONFIG_PATH },
    input: JSON.stringify({ cwd: repo, session_id: 'selftest', prompt: 'hook token=redaction-fixture-value' }),
    encoding: 'utf8',
  });
  if (hookRun.status !== 0) throw new Error((hookRun.stderr || hookRun.stdout || 'hook selftest failed').trim());
  const internal = fs.readFileSync(internalLogFile(config()), 'utf8');
  if (!internal.includes('"action":"hook_start"')) throw new Error('hook_start log missing');
  if (!internal.includes('"action":"hook_success"')) throw new Error('hook_success log missing');
  configure({ timeZone: 'UTC', promptMode: 'off' });
  const updated = config();
  if (updated.timeZone !== 'UTC' || updated.promptMode !== 'off') throw new Error('config update failed');
  configure({ deviceId: 'test-device' });
  if (config().deviceId !== 'test-device') throw new Error('device config failed');
  configure({ reportLanguage: 'en' });
  if (config().reportLanguage !== 'en') throw new Error('report language config failed');
  configure({ ownerName: 'onmhj-owner', ownerEmail: 'owner@example.local' });
  const ownerCfg = config();
  if (ownerCfg.ownerName !== 'onmhj-owner' || ownerCfg.ownerEmail !== 'owner@example.local') {
    throw new Error('owner config failed');
  }
  if (updated.reportAuth !== 'agent') throw new Error('default report auth must be agent');
  configure({
    reportAuth: 'api',
    reportApiBaseUrl: 'https://example.invalid/v1',
    reportApiModel: 'test-model',
    reportApiKeyEnv: 'ONMHJ_TEST_KEY',
  });
  const apiCfg = config();
  const apiRuntime = reportRuntime(apiCfg);
  if (apiRuntime.auth !== 'api' || apiRuntime.baseUrl !== 'https://example.invalid/v1' || apiRuntime.model !== 'test-model') {
    throw new Error('api report config failed');
  }
  inject({ date: '2026-07-09', cwd: repo, text: 'manual token=redaction-fixture-value', sourceId: 'selftest-inject' });
  const imported = fs.readFileSync(eventFile(config(), '2026-07-09'), 'utf8');
  if (!imported.includes('"sourceId":"selftest-inject"')) throw new Error('manual inject missing');
  if (imported.includes('redaction-fixture-value')) throw new Error('manual inject redaction failed');
  const importFile = path.join(tmp, 'import.jsonl');
  fs.writeFileSync(importFile, JSON.stringify({
    tsUtc: '2026-07-09T01:00:00.000Z',
    localDate: '2026-07-09',
    cwd: repo,
    source: 'selftest',
    sourceId: 'selftest-import',
    promptPreview: 'import token=redaction-import-fixture',
  }) + '\n');
  importEvents(importFile);
  const afterImport = fs.readFileSync(eventFile(config(), '2026-07-09'), 'utf8');
  if (!afterImport.includes('"sourceId":"selftest-import"')) throw new Error('manual import missing');
  if (afterImport.includes('redaction-import-fixture')) throw new Error('manual import redaction failed');
  process.stdout.write('selftest ok\n');
  } finally {
    CONFIG_PATH = originalConfigPath;
  }
}

async function main() {
  const [cmd, first, ...rest] = process.argv.slice(2);
  const opts = parseOptions([first, ...rest].filter(Boolean));
  if (cmd === 'hook') return hook(first || 'unknown');
  if (cmd === 'register') return register(first, opts);
  if (cmd === 'config') return configure(opts);
  if (cmd === 'inject') return inject(opts);
  if (cmd === 'import') return importEvents(first);
  if (cmd === 'flush') return flush(first && !first.startsWith('--') ? first : undefined, opts);
  if (cmd === 'ejmhj') return runFullReport(config(), first && !first.startsWith('--') ? first : previousLocalDateKey(new Date(), config().timeZone), opts);
  if (cmd === 'worker') return worker();
  if (cmd === 'status') return status();
  if (cmd === 'selftest') return selftest();
  throw new Error(usage());
}

function setConfigPath(file) {
  CONFIG_PATH = file;
}

module.exports = {
  buildReportPrompt,
  config,
  generateReport,
  requestApi,
  readReportJob,
  reportScheduleState,
  runFullReport,
  setConfigPath,
  tryScheduleReportJobs,
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
