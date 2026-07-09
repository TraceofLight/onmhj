const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hookConfig = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'codex-hooks.json'), 'utf8'));

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
