const fs = require('fs');
const os = require('os');
const path = require('path');
const { sessionSourcesFile } = require('./paths');
const { zstdAvailable } = require('./session-files');
const { readJson, writeJson } = require('./util');

const SESSION_PARSER_VERSION = 12;

function sessionSuccessor(file) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const archived = path.join(codexHome, 'archived_sessions', path.basename(file));
  return [file + '.zst', archived, archived + '.zst']
    .find(candidate => fs.existsSync(candidate) && (zstdAvailable() || !candidate.endsWith('.zst')));
}

function canonicalSessionPath(file) {
  const resolved = path.resolve(file);
  if (process.platform !== 'win32') return resolved;
  if (resolved.startsWith('\\\\?\\UNC\\')) return '\\\\' + resolved.slice(8);
  return resolved.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
}

function sessionProvider(file) {
  return String(file).toLowerCase().includes(`${path.sep}.claude${path.sep}`) ? 'claude' : 'codex';
}

function rememberSessionSource(cfg, file, provider = sessionProvider(file)) {
  const sources = readJson(sessionSourcesFile(cfg), []);
  const resolved = canonicalSessionPath(file);
  if (!sources.some(source => source.path === resolved)) {
    sources.push({ provider, path: resolved });
    writeJson(sessionSourcesFile(cfg), sources);
  }
}

function findJsonlFiles(root, provider, files = []) {
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'subagents') continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) findJsonlFiles(target, provider, files);
    else if (entry.isFile() && (entry.name.endsWith('.jsonl') || (/\.jsonl\.zstd?$/.test(entry.name) && zstdAvailable()))) {
      files.push({ provider, path: target });
    }
  }
  return files;
}

// DSH keeps one append-only `session.v<N>.jsonl.zstd` per session under `$DSH_HOME/sessions`.
function findDshSessionFiles() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return findJsonlFiles(path.join(dshHome, 'sessions'), 'dsh')
    .filter(source => /^session\.v\d+\.jsonl\.zstd$/.test(path.basename(source.path)));
}

function discoverSessionSources() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [
    ...findJsonlFiles(path.join(codexHome, 'sessions'), 'codex'),
    ...findJsonlFiles(path.join(codexHome, 'archived_sessions'), 'codex'),
    ...findJsonlFiles(path.join(os.homedir(), '.claude', 'projects'), 'claude'),
    ...findDshSessionFiles(),
  ];
}

module.exports = {
  SESSION_PARSER_VERSION,
  canonicalSessionPath,
  discoverSessionSources,
  rememberSessionSource,
  sessionSuccessor,
};
