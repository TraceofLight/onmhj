const path = require('path');
const crypto = require('crypto');
const { utcDateKey } = require('./util');

function eventFile(cfg, date = utcDateKey()) {
  return path.join(cfg.stateDir, 'events', date + '.jsonl');
}

function internalLogFile(cfg, date = utcDateKey()) {
  return path.join(cfg.stateDir, 'internal', date + '.jsonl');
}

function workerLogFile(cfg) {
  return path.join(cfg.stateDir, 'worker.log');
}

function sessionIngestDir(cfg) {
  return path.join(cfg.stateDir, 'session-ingest');
}

function sessionIngestLockFile(cfg) {
  return path.join(sessionIngestDir(cfg), 'ingestion.lock');
}

function eventSpoolLockFile(cfg) {
  return path.join(sessionIngestDir(cfg), 'event-spool.lock');
}

function cursorFile(cfg) {
  return path.join(sessionIngestDir(cfg), 'cursors.json');
}

function quarantineFile(cfg, file) {
  const id = crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16);
  return path.join(sessionIngestDir(cfg), 'quarantine', id + '.json');
}

function sessionSourcesFile(cfg) {
  return path.join(sessionIngestDir(cfg), 'sources.json');
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

function publicationLockFile(cfg) {
  return path.join(reportJobsDir(cfg), 'publication.lock');
}

module.exports = {
  cursorFile,
  deviceConfirmationDir,
  deviceConfirmationFile,
  eventFile,
  eventSpoolLockFile,
  internalLogFile,
  localConfirmationFile,
  publicationLockFile,
  quarantineFile,
  reportJobFile,
  reportJobLockFile,
  reportJobsDir,
  sessionIngestDir,
  sessionIngestLockFile,
  sessionSourcesFile,
  workerLockFile,
  workerLogFile,
};
