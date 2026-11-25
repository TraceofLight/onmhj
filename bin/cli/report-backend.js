const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const {
  DEFAULT_REPORT_API_KEY_ENV,
  nativeAgentProvider,
  reportAgentEffort,
  reportAgentModel,
  reportBackendTimeoutMs,
} = require('./config');
const { redactSecrets } = require('./references');

function reportRuntime(cfg) {
  if (cfg.reportAuth === 'api') {
    return {
      auth: 'api',
      baseUrl: cfg.reportApiBaseUrl,
      model: cfg.reportApiModel,
      apiKeyEnv: cfg.reportApiKeyEnv,
      apiKeyFile: cfg.reportApiKeyFile,
      effort: cfg.reportApiEffort,
      hasApiKey: hasReportApiKey(cfg, process.env),
    };
  }
  const provider = nativeAgentProvider(cfg);
  return {
    auth: 'agent',
    agent: cfg.reportAgent,
    provider,
    model: reportAgentModel(cfg, provider),
    effort: reportAgentEffort(cfg),
    timeoutMinutes: reportBackendTimeoutMs(cfg) / 60 / 1000,
    description: `Use local ${cfg.reportAgent === 'auto' ? 'runtime-native' : cfg.reportAgent} authentication for isolated final report generation.`,
  };
}

function runAgent(command, args, input, options = {}) {
  return new Promise(resolve => {
    const { timeout, ...spawnOptions } = options;
    let child;
    try {
      child = childProcess.spawn(command, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timeoutError;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', error => finish({ status: null, error }));
    child.on('close', (status, signal) => finish({ status, signal, ...(timeoutError ? { error: timeoutError } : {}) }));
    const timer = timeout ? setTimeout(() => {
      timeoutError = new Error(`spawn ${command} ETIMEDOUT`);
      timeoutError.code = 'ETIMEDOUT';
      child.kill('SIGTERM');
    }, timeout) : null;
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function resolveCodexExecutable(env = process.env) {
  if (env.ONMHJ_CODEX_EXECUTABLE) return env.ONMHJ_CODEX_EXECUTABLE;
  if (process.platform !== 'win32') return 'codex';
  const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const executable = path.join(
    env.APPDATA || '',
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    packageName,
    'vendor',
    target,
    'bin',
    'codex.exe',
  );
  if (!fs.existsSync(executable)) {
    throw new Error('native Codex executable not found; install Codex CLI with npm or set ONMHJ_CODEX_EXECUTABLE');
  }
  return executable;
}

function resolveClaudeExecutable(env = process.env) {
  return env.ONMHJ_CLAUDE_EXECUTABLE || 'claude';
}

function claudeAgentEnvironment(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return childEnv;
}

async function requestApi(url, options, body, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...options, body: JSON.stringify(body) });
  const text = await response.text();
  if (response.ok && body && body.stream) return parseEventStream(text);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    if (!response.ok) throw new Error(`report API failed: HTTP ${response.status}: ${redactSecrets(text || 'empty response')}`);
    throw new Error('report API returned invalid JSON');
  }
  if (!response.ok) {
    const message = value && value.error && value.error.message ? value.error.message : `HTTP ${response.status}`;
    throw new Error(`report API failed: ${redactSecrets(message)}`);
  }
  return value;
}

// Collects streamed content deltas into the non-streaming response shape; reasoning deltas are dropped.
function parseEventStream(text) {
  let content = '';
  for (const line of String(text).split(/\r?\n/)) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('report API returned an invalid event stream');
    }
    if (event.error) throw new Error(`report API failed: ${redactSecrets(event.error.message || 'stream error')}`);
    const delta = event.choices && event.choices[0] && event.choices[0].delta;
    if (delta && typeof delta.content === 'string') content += delta.content;
  }
  return { choices: [{ message: { content } }] };
}

function reportApiKey(cfg, env, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  const name = cfg.reportApiKeyEnv || DEFAULT_REPORT_API_KEY_ENV;
  if (env[name]) return env[name];
  return cfg.reportApiKeyFile ? apiKeyFromFile(readFile(cfg.reportApiKeyFile), name) : '';
}

// Accepts a file holding only the key, or `NAME: value` / `NAME=value` lines such as DSH credentials.
function apiKeyFromFile(text, name) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s*[:=]\\s*["']?([^"'\\s#]+)`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return lines.length === 1 && !/\s/.test(lines[0]) ? lines[0] : '';
}

function hasReportApiKey(cfg, env) {
  try {
    return Boolean(reportApiKey(cfg, env));
  } catch {
    return false;
  }
}

function reportApiKeySources(cfg) {
  const name = cfg.reportApiKeyEnv || DEFAULT_REPORT_API_KEY_ENV;
  return cfg.reportApiKeyFile ? `${name} (env or ${cfg.reportApiKeyFile})` : name;
}

async function callReportBackend(cfg, prompt, deps = {}) {
  if (cfg.reportAuth === 'api') {
    if (!cfg.reportApiBaseUrl) throw new Error('report API base URL is required');
    if (!cfg.reportApiModel) throw new Error('report API model is required');
    const env = deps.env || process.env;
    const apiKey = reportApiKey(cfg, env, deps.readFile);
    if (!apiKey) throw new Error(`report API key is missing: ${reportApiKeySources(cfg)}`);
    const callApi = deps.requestApi || requestApi;
    const result = await callApi(
      cfg.reportApiBaseUrl.replace(/\/$/, '') + '/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(reportBackendTimeoutMs(cfg)),
      },
      {
        model: cfg.reportApiModel,
        stream: true,
        ...(cfg.reportApiEffort ? { reasoning_effort: cfg.reportApiEffort } : {}),
        messages: [{ role: 'user', content: prompt }],
      },
    );
    return result && result.choices && result.choices[0] && result.choices[0].message
      ? result.choices[0].message.content
      : '';
  }

  const callAgent = deps.runAgent || runAgent;
  const env = deps.env || process.env;
  const provider = nativeAgentProvider(cfg, env);
  const model = reportAgentModel(cfg, provider);
  const effort = reportAgentEffort(cfg);
  let command = deps.codexCommand;
  if (!command && provider === 'codex') command = resolveCodexExecutable(env);
  let args = [
    'exec',
    '--ignore-user-config',
    '--model',
    model,
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '--disable',
    'multi_agent',
    '--disable',
    'apps',
    '--disable',
    'hooks',
    '--disable',
    'goals',
    '-c',
    'tools.view_image=false',
    '-c',
    'tools.web_search=false',
    '-c',
    `model_reasoning_effort="${effort}"`,
    '-',
  ];
  if (provider === 'claude') {
    command = deps.claudeCommand || resolveClaudeExecutable(env);
    args = ['-p', '--safe-mode', '--tools', '', '--no-session-persistence', '--no-chrome', '--model', model, '--effort', effort, '--output-format', 'text'];
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-report-agent-'));
  let result;
  try {
    const options = { cwd, timeout: reportBackendTimeoutMs(cfg), windowsHide: true };
    if (provider === 'claude') options.env = claudeAgentEnvironment(env);
    result = await callAgent(command, args, prompt, options);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  if (!result || result.status !== 0) {
    const timedOut = result && result.error && result.error.code === 'ETIMEDOUT';
    const detail = result && (timedOut
      ? result.error.message
      : result.stderr || result.stdout || (result.error && result.error.message));
    throw new Error(`report agent failed: ${redactSecrets(detail || 'unknown error')}`.trim());
  }
  return result.stdout;
}

module.exports = {
  callReportBackend,
  reportRuntime,
  requestApi,
};
