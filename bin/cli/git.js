const childProcess = require('child_process');

function run(cmd, args, cwd, allowFail = false) {
  const out = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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

function syncReportRepo(repoPath) {
  const upstream = gitValue(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath);
  if (!upstream) return false;
  run('git', ['pull', '--rebase', '--autostash'], repoPath);
  return true;
}

function assertCleanIndex(repoPath) {
  const staged = gitValue(['diff', '--cached', '--name-only'], repoPath);
  if (staged) throw new Error(`report repo has staged changes:\n${staged}`);
}

function commitArtifacts(cfg, key, targets, opts = {}) {
  run('git', ['add', ...targets], cfg.repoPath);
  const diff = run('git', ['diff', '--cached', '--quiet'], cfg.repoPath, true);
  if (diff.status !== 0) run('git', ['commit', '-m', opts.message || `log: ${key} AI worklog`], cfg.repoPath);
  if (!opts.noPush) run('git', ['push'], cfg.repoPath);
  return diff.status !== 0;
}

module.exports = {
  assertCleanIndex,
  commitArtifacts,
  findGitRoot,
  gitValue,
  globalGitConfig,
  isGitRepo,
  run,
  syncReportRepo,
};
