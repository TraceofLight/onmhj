const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
const hookPath = path.join(root, 'hooks', 'hooks.json');
const eventNames = ['SessionStart', 'UserPromptSubmit'];

function readHookConfig() {
  assert.ok(fs.existsSync(hookPath), 'Claude hook config must exist at hooks/hooks.json');
  return JSON.parse(fs.readFileSync(hookPath, 'utf8'));
}

function commandHook(config, eventName) {
  return config.hooks[eventName][0].hooks[0];
}

function expectedHook(eventName) {
  return {
    type: 'command',
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/bin/onmhj.js', 'hook', eventName],
    timeout: 5,
  };
}

test('Claude manifest relies on default hook auto-discovery', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.ok(fs.existsSync(hookPath));
});

test('Claude loader accepts default hook auto-discovery', t => {
  const version = childProcess.spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') return t.skip('Claude CLI unavailable');
  assert.equal(version.status, 0, version.stderr || version.error?.message || version.stdout);

  const result = childProcess.spawnSync(
    'claude',
    ['--plugin-dir', root, 'plugin', 'list', '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);

  const plugins = JSON.parse(result.stdout);
  const inline = plugins.find(plugin => plugin.id === 'onmhj@inline');
  assert.ok(inline, 'onmhj@inline must be present');
  assert.equal(inline.version, '0.1.17');
  assert.equal(inline.enabled, true);
  assert.deepEqual(inline.errors || [], []);
});

test('Claude hook config defines only SessionStart and UserPromptSubmit', () => {
  const config = readHookConfig();

  assert.deepEqual(Object.keys(config), ['hooks']);
  assert.deepEqual(Object.keys(config.hooks).sort(), [...eventNames].sort());
  assert.equal(config.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.equal(Object.hasOwn(config.hooks.UserPromptSubmit[0], 'matcher'), false);
});

test('Claude handlers use the minimal exec form', () => {
  const config = readHookConfig();

  for (const eventName of eventNames) {
    assert.equal(config.hooks[eventName].length, 1);
    assert.equal(config.hooks[eventName][0].hooks.length, 1);
    assert.deepEqual(commandHook(config, eventName), expectedHook(eventName));
  }
});

test('Claude handlers execute and record their hook events', t => {
  const config = readHookConfig();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-claude-hooks-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const stateDir = path.join(tmp, 'state');
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ stateDir }));

  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: root,
    ONMHJ_CONFIG: configPath,
  };

  for (const eventName of eventNames) {
    const hook = commandHook(config, eventName);
    const args = hook.args.map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}', env.CLAUDE_PLUGIN_ROOT));
    const input = {
      cwd: root,
      session_id: `claude-${eventName}`,
      prompt: eventName === 'UserPromptSubmit' ? 'record this prompt' : '',
    };
    const result = childProcess.spawnSync(hook.command, args, {
      cwd: root,
      env,
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: hook.timeout * 1000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const eventsDir = path.join(stateDir, 'events');
  const records = fs.readdirSync(eventsDir)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file => fs.readFileSync(path.join(eventsDir, file), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));

  for (const eventName of eventNames) {
    const record = records.find(item => item.event === eventName);
    assert.ok(record, `${eventName} event was not recorded`);
    assert.equal(record.sessionId, `claude-${eventName}`);
  }
});
