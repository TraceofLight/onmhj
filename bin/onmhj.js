#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const CONFIG_PATH = process.env.ONMHJ_CONFIG || path.join(os.homedir(), '.config', 'onmhj', 'config.json');
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'onmhj');

function usage() {
  return [
    'Usage:',
    '  onmhj hook <event>',
    '  onmhj register <git-repo-path> [--prompt=preview|full|off] [--timezone=Area/City]',
    '  onmhj flush [YYYY-MM-DD] [--no-push]',
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
  };
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

function eventFile(cfg, date = utcDateKey()) {
  return path.join(cfg.stateDir, 'events', date + '.jsonl');
}

function internalLogFile(cfg, date = utcDateKey()) {
  return path.join(cfg.stateDir, 'internal', date + '.jsonl');
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
    if (arg === '--no-push') opts.noPush = true;
  }
  return opts;
}

function register(repoPath, opts) {
  if (!repoPath) throw new Error(usage());
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) throw new Error(`repo not found: ${resolved}`);
  if (!isGitRepo(resolved)) throw new Error(`not a git repo: ${resolved}`);
  if (opts.promptMode && !['preview', 'full', 'off'].includes(opts.promptMode)) {
    throw new Error('prompt mode must be preview, full, or off');
  }
  if (opts.timeZone) localDateKey(new Date(), opts.timeZone);
  const cfg = config();
  cfg.repoPath = resolved;
  if (opts.promptMode) cfg.promptMode = opts.promptMode;
  if (opts.timeZone) cfg.timeZone = opts.timeZone;
  writeJson(CONFIG_PATH, cfg);
  writeInternalLog(cfg, 'register', {
    repoPath: resolved,
    promptMode: cfg.promptMode,
    timeZone: cfg.timeZone,
  });
  process.stdout.write(`registered ${resolved}\n`);
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

function summarize(events, date) {
  const byRepo = new Map();
  for (const event of events) {
    const key = event.gitRoot || event.cwd || '(unknown)';
    const row = byRepo.get(key) || { count: 0, prompts: [] };
    row.count += 1;
    const prompt = event.prompt || event.promptPreview;
    if (prompt) row.prompts.push(prompt.replace(/\s+/g, ' ').trim());
    byRepo.set(key, row);
  }

  const lines = [
    `# ${date} AI worklog`,
    '',
    `Time zone: ${events[0] && events[0].timeZone ? events[0].timeZone : 'unknown'}`,
    'Timeline: UTC timestamps',
    '',
    `Events: ${events.length}`,
    '',
    '## Repositories',
    '',
  ];
  for (const [repo, row] of byRepo.entries()) {
    lines.push(`### ${repo}`, '', `Events: ${row.count}`, '');
    if (row.prompts.length) {
      lines.push('Prompts:', '');
      for (const prompt of row.prompts.slice(0, 50)) lines.push(`- ${prompt}`);
      if (row.prompts.length > 50) lines.push(`- ... ${row.prompts.length - 50} more`);
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function flush(date, opts) {
  const cfg = config();
  if (!cfg.repoPath) throw new Error('run `onmhj register <git-repo-path>` first');
  if (!isGitRepo(cfg.repoPath)) throw new Error(`registered path is not a git repo: ${cfg.repoPath}`);

  const key = date || localDateKey(new Date(), cfg.timeZone);
  const events = loadEventsForLocalDate(cfg, key);
  if (!events.length) {
    writeInternalLog(cfg, 'flush_no_events', { date: key });
    process.stdout.write(`no events for ${key}\n`);
    return;
  }

  const rawTarget = path.join(cfg.repoPath, 'raw', 'ai-sessions', key + '.jsonl');
  const dailyTarget = path.join(cfg.repoPath, 'daily', key + '.md');
  fs.mkdirSync(path.dirname(rawTarget), { recursive: true });
  fs.mkdirSync(path.dirname(dailyTarget), { recursive: true });
  fs.writeFileSync(rawTarget, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(dailyTarget, summarize(events, key));

  run('git', ['add', rawTarget, dailyTarget], cfg.repoPath);
  const diff = run('git', ['diff', '--cached', '--quiet'], cfg.repoPath, true);
  if (diff.status === 0) {
    writeInternalLog(cfg, 'flush_no_changes', { date: key, eventCount: events.length });
    process.stdout.write(`no git changes for ${key}\n`);
    return;
  }
  run('git', ['commit', '-m', `log: ${key} AI worklog`], cfg.repoPath);
  if (!opts.noPush) run('git', ['push'], cfg.repoPath);
  writeInternalLog(cfg, 'flush', {
    date: key,
    eventCount: events.length,
    rawTarget,
    dailyTarget,
    pushed: !opts.noPush,
  });
  process.stdout.write(`flushed ${key}\n`);
}

function status() {
  const cfg = config();
  const key = localDateKey(new Date(), cfg.timeZone);
  const events = loadEventsForLocalDate(cfg, key);
  const logFile = internalLogFile(cfg);
  process.stdout.write([
    `config: ${CONFIG_PATH}`,
    `state: ${cfg.stateDir}`,
    `internalLog: ${logFile}`,
    `repo: ${cfg.repoPath || '(not registered)'}`,
    `prompt: ${cfg.promptMode}`,
    `timeZone: ${cfg.timeZone}`,
    `todayEvents: ${events.length}`,
  ].join('\n') + '\n');
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-'));
  const repo = path.join(tmp, 'repo');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(repo);
  run('git', ['init'], repo);
  run('git', ['config', 'user.email', 'onmhj@example.local'], repo);
  run('git', ['config', 'user.name', 'onmhj'], repo);
  writeJson(CONFIG_PATH, { repoPath: repo, stateDir: state, promptMode: 'preview', timeZone: 'Asia/Seoul' });
  appendLine(eventFile(config(), '2026-07-08'), JSON.stringify({
    ts: '2026-07-08T15:00:00.000Z',
    tsUtc: '2026-07-08T15:00:00.000Z',
    timeZone: 'Asia/Seoul',
    localDate: '2026-07-09',
    event: 'UserPromptSubmit',
    cwd: repo,
    gitRoot: repo,
    promptPreview: '테스트 작업 token=redaction-fixture-value [REDACTION_FIXTURE]',
  }));
  flush('2026-07-09', { noPush: true });
  const daily = fs.readFileSync(path.join(repo, 'daily', '2026-07-09.md'), 'utf8');
  const raw = fs.readFileSync(path.join(repo, 'raw', 'ai-sessions', '2026-07-09.jsonl'), 'utf8');
  if (!daily) throw new Error('daily file missing');
  if (daily.includes('redaction-fixture-value') || raw.includes('[REDACTION_FIXTURE]')) {
    throw new Error('secret redaction failed');
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
  process.stdout.write('selftest ok\n');
}

function main() {
  const [cmd, first, ...rest] = process.argv.slice(2);
  const opts = parseOptions([first, ...rest].filter(Boolean));
  if (cmd === 'hook') return hook(first || 'unknown');
  if (cmd === 'register') return register(first, opts);
  if (cmd === 'flush') return flush(first && !first.startsWith('--') ? first : undefined, opts);
  if (cmd === 'status') return status();
  if (cmd === 'selftest') return selftest();
  throw new Error(usage());
}

try {
  main();
} catch (err) {
  try {
    writeInternalLog(config(), 'error', {
      command: process.argv.slice(2).join(' '),
      ...errorDetails(err),
    });
  } catch {}
  process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
}
