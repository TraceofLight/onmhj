const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const TASK_NAME = 'onmhj-catchup';
const LAUNCHD_LABEL = 'com.onmhj.catchup';

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function launchdPlan(ctx) {
  const file = path.posix.join(ctx.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${ctx.uid}`;
  const args = ctx.command.map(value => `    <string>${xmlEscape(value)}</string>`).join('\n');
  const env = Object.entries(ctx.env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(ctx.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(ctx.logFile)}</string>
</dict>
</plist>
`;
  return {
    files: [{ path: file, content }],
    // bootout first so a reinstall picks up a changed command or PATH.
    install: [{ args: ['launchctl', 'bootout', domain, file], optional: true }, { args: ['launchctl', 'bootstrap', domain, file] }],
    uninstall: [{ args: ['launchctl', 'bootout', domain, file], optional: true }],
    status: { args: ['launchctl', 'print', `${domain}/${LAUNCHD_LABEL}`] },
  };
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function systemdPlan(ctx) {
  const dir = path.posix.join(ctx.home, '.config', 'systemd', 'user');
  const env = Object.entries(ctx.env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n');
  const service = `[Unit]
Description=onmhj session catch-up

[Service]
Type=oneshot
${env}
ExecStart=${ctx.command.map(systemdQuote).join(' ')}
`;
  // Persistent runs a slot missed while the machine was off or asleep.
  const timer = `[Unit]
Description=Run onmhj session catch-up hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
`;
  return {
    files: [
      { path: path.posix.join(dir, `${TASK_NAME}.service`), content: service },
      { path: path.posix.join(dir, `${TASK_NAME}.timer`), content: timer },
    ],
    install: [
      { args: ['systemctl', '--user', 'daemon-reload'] },
      { args: ['systemctl', '--user', 'enable', '--now', `${TASK_NAME}.timer`] },
    ],
    uninstall: [{ args: ['systemctl', '--user', 'disable', '--now', `${TASK_NAME}.timer`], optional: true }],
    status: { args: ['systemctl', '--user', 'list-timers', `${TASK_NAME}.timer`] },
  };
}

// Task Scheduler runs with the user's own environment, so only the command is registered.
function windowsPlan(ctx) {
  const command = ctx.command.map(value => `"${value}"`).join(' ');
  return {
    files: [],
    install: [{ args: ['schtasks', '/Create', '/F', '/SC', 'HOURLY', '/TN', TASK_NAME, '/TR', command] }],
    uninstall: [{ args: ['schtasks', '/Delete', '/F', '/TN', TASK_NAME], optional: true }],
    status: { args: ['schtasks', '/Query', '/TN', TASK_NAME] },
  };
}

const PLANS = { darwin: launchdPlan, linux: systemdPlan, win32: windowsPlan };

function schedulePlan(platform, ctx) {
  const plan = PLANS[platform];
  if (!plan) throw new Error(`periodic schedule is not supported on ${platform}`);
  return plan(ctx);
}

function runCommand(args) {
  return childProcess.spawnSync(args[0], args.slice(1), { stdio: 'inherit' }).status;
}

function runStep(step, run) {
  const status = run(step.args);
  if (status !== 0 && !step.optional) throw new Error(`${step.args.join(' ')} exited with ${status}`);
  return status;
}

function applySchedule(action, plan, run = runCommand) {
  if (action === 'install') {
    for (const file of plan.files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content);
    }
    plan.install.forEach(step => runStep(step, run));
    return 0;
  }
  if (action === 'uninstall') {
    plan.uninstall.forEach(step => runStep(step, run));
    for (const file of plan.files) fs.rmSync(file.path, { force: true });
    return 0;
  }
  if (action === 'status') return runStep({ ...plan.status, optional: true }, run);
  throw new Error('usage: onmhj schedule install|uninstall|status');
}

module.exports = { applySchedule, schedulePlan };
