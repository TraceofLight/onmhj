const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applySchedule, schedulePlan } = require('../bin/schedule');

function context(home) {
  return {
    home,
    uid: 501,
    command: ['/opt/node dir/bin/node', '/src/onmhj/bin/onmhj.js', 'catchup'],
    env: { PATH: '/usr/bin:/opt/a&b', ONMHJ_CONFIG: '/cfg/100%/config.json' },
    logFile: '/state/catchup.log',
  };
}

test('macOS plan registers an hourly launchd agent with the captured environment', () => {
  const plan = schedulePlan('darwin', context('/Users/me'));
  const plist = '/Users/me/Library/LaunchAgents/com.onmhj.catchup.plist';
  assert.deepEqual(plan.files.map(file => file.path), [plist]);
  const content = plan.files[0].content;
  assert.match(content, /<string>\/opt\/node dir\/bin\/node<\/string>\n {4}<string>\/src\/onmhj\/bin\/onmhj.js<\/string>\n {4}<string>catchup<\/string>/);
  assert.match(content, /<key>PATH<\/key>\n {4}<string>\/usr\/bin:\/opt\/a&amp;b<\/string>/);
  assert.match(content, /<key>StartInterval<\/key>\n {2}<integer>3600<\/integer>/);
  assert.deepEqual(plan.install.map(step => [step.args.join(' '), !!step.optional]), [
    [`launchctl bootout gui/501 ${plist}`, true],
    [`launchctl bootstrap gui/501 ${plist}`, false],
  ]);
  assert.deepEqual(plan.status.args, ['launchctl', 'print', 'gui/501/com.onmhj.catchup']);
});

test('Linux plan registers a persistent hourly systemd user timer', () => {
  const plan = schedulePlan('linux', context('/home/me'));
  const dir = '/home/me/.config/systemd/user';
  assert.deepEqual(plan.files.map(file => file.path), [`${dir}/onmhj-catchup.service`, `${dir}/onmhj-catchup.timer`]);
  const [service, timer] = plan.files.map(file => file.content);
  assert.match(service, /^ExecStart="\/opt\/node dir\/bin\/node" "\/src\/onmhj\/bin\/onmhj.js" "catchup"$/m);
  assert.match(service, /^Environment="ONMHJ_CONFIG=\/cfg\/100%%\/config.json"$/m);
  assert.match(timer, /^OnCalendar=hourly$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.deepEqual(plan.install.at(-1).args, ['systemctl', '--user', 'enable', '--now', 'onmhj-catchup.timer']);
});

test('Windows plan registers an hourly scheduled task', () => {
  const plan = schedulePlan('win32', context('C:\\Users\\me'));
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.install[0].args, ['schtasks', '/Create', '/F', '/SC', 'HOURLY', '/TN', 'onmhj-catchup',
    '/TR', '"/opt/node dir/bin/node" "/src/onmhj/bin/onmhj.js" "catchup"']);
  assert.deepEqual(plan.uninstall[0].args, ['schtasks', '/Delete', '/F', '/TN', 'onmhj-catchup']);
});

test('unsupported platforms are rejected', () => {
  assert.throws(() => schedulePlan('aix', context('/home/me')), /not supported on aix/);
});

test('install writes files before commands, uninstall removes them, and required failures throw', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onmhj-schedule-'));
  const plan = schedulePlan('linux', context(home));
  const calls = [];
  const run = args => {
    calls.push([args.join(' '), plan.files.every(file => fs.existsSync(file.path))]);
    return 0;
  };
  applySchedule('install', plan, run);
  assert.deepEqual(calls.map(([, written]) => written), [true, true]);
  assert.equal(fs.readFileSync(plan.files[1].path, 'utf8'), plan.files[1].content);

  // Disabling a timer that is not enabled is not an error.
  applySchedule('uninstall', plan, () => 1);
  assert.equal(plan.files.some(file => fs.existsSync(file.path)), false);

  assert.throws(() => applySchedule('install', plan, () => 1), /systemctl --user daemon-reload exited with 1/);
  assert.equal(applySchedule('status', plan, () => 4), 4);
  assert.throws(() => applySchedule('restart', plan, run), /usage: onmhj schedule/);
});
