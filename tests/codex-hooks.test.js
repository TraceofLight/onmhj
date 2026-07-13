const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hookConfig = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));
const legacyHookConfig = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'codex-hooks.json'), 'utf8'));
const codexManifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));

function commandHooks(eventName) {
  return hookConfig.hooks[eventName].flatMap(group => group.hooks);
}

test('Codex hooks define Windows commands for command hooks', () => {
  for (const eventName of ['SessionStart', 'UserPromptSubmit']) {
    for (const hook of commandHooks(eventName)) {
      assert.equal(typeof hook.commandWindows, 'string');
      assert.notEqual(hook.commandWindows.trim(), '');
    }
  }
});

test('Codex manifest exposes bundled hooks file', () => {
  assert.equal(codexManifest.hooks, './hooks/codex-hooks.json');
  assert.deepEqual(legacyHookConfig, hookConfig);
});

test('Codex POSIX hooks use node resolver wrapper', () => {
  for (const eventName of ['SessionStart', 'UserPromptSubmit']) {
    for (const hook of commandHooks(eventName)) {
      assert.match(hook.command, /bin\/onmhj-node/);
      assert.doesNotMatch(hook.command, /exec node /);
    }
  }
});

test('node resolver wrapper is executable', { skip: process.platform === 'win32' }, () => {
  const mode = fs.statSync(path.join(root, 'bin', 'onmhj-node')).mode;
  assert.equal(Boolean(mode & 0o111), true);
});

test('Codex Windows hook commands run in PowerShell', { skip: process.platform !== 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-hooks-'));
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ stateDir: path.join(tmp, 'state') }));
  const env = {
    ...process.env,
    CODEX_PLUGIN_ROOT: root,
    ONMHJ_CONFIG: configPath,
  };

  for (const eventName of ['SessionStart', 'UserPromptSubmit']) {
    for (const hook of commandHooks(eventName)) {
      const result = childProcess.spawnSync('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        hook.commandWindows,
      ], {
        cwd: root,
        env,
        input: JSON.stringify({ cwd: root, session_id: 'test', prompt: 'hello' }),
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  }
});

test('legacy preview config cannot truncate hook prompts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-lossless-hook-'));
  const stateDir = path.join(tmp, 'state');
  const configPath = path.join(tmp, 'config.json');
  const prompt = `task-${'p'.repeat(400)}`;
  fs.writeFileSync(configPath, JSON.stringify({
    stateDir,
    promptMode: 'preview',
    timeZone: 'UTC',
    deviceId: 'test-device',
  }));

  const result = childProcess.spawnSync(process.execPath, [
    path.join(root, 'bin', 'onmhj.js'),
    'hook',
    'UserPromptSubmit',
  ], {
    cwd: root,
    env: { ...process.env, ONMHJ_CONFIG: configPath },
    input: JSON.stringify({ cwd: root, session_id: 'test-session', prompt }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const eventFile = path.join(stateDir, 'events', fs.readdirSync(path.join(stateDir, 'events'))[0]);
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8').trim());
  assert.equal(event.prompt, prompt);
  assert.equal(Object.hasOwn(event, 'promptPreview'), false);
});

test('prompt capture mode CLI is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-lossless-cli-'));
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ stateDir: path.join(tmp, 'state') }));

  const result = childProcess.spawnSync(process.execPath, [
    path.join(root, 'bin', 'onmhj.js'),
    'config',
    '--prompt=off',
  ], {
    cwd: root,
    env: { ...process.env, ONMHJ_CONFIG: configPath },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prompt capture is always full/);
});

test('selftest does not overwrite selected user config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-selftest-'));
  const configPath = path.join(tmp, 'config.json');
  const userConfig = {
    repoPath: path.join(tmp, 'user-repo'),
    stateDir: path.join(tmp, 'user-state'),
    timeZone: 'Asia/Seoul',
    deviceId: 'user-device',
  };
  fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2) + '\n');

  const result = childProcess.spawnSync(process.execPath, [path.join(root, 'bin', 'onmhj.js'), 'selftest'], {
    cwd: root,
    env: { ...process.env, ONMHJ_CONFIG: configPath },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), userConfig);
});

test('Codex command prompts expose existing onmhj CLI entry points', () => {
  const onmhj = fs.readFileSync(path.join(root, 'commands', 'onmhj.md'), 'utf8');
  const ejmhj = fs.readFileSync(path.join(root, 'commands', 'ejmhj.md'), 'utf8');

  assert.match(onmhj, /bin\/onmhj\.js/);
  assert.match(ejmhj, /bin\/onmhj\.js" ejmhj/);
});
