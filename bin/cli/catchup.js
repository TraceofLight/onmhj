const path = require('path');
const { DEFAULT_TARGET_BYTES } = require('../report-chunks');
const { prefetchExtraction } = require('../report-facts');
const { config } = require('./config');
const { acquireLock, releaseLock } = require('./locks');
const { errorDetails, writeInternalLog } = require('./log');
const { prepareRaw, publishSessionEvents } = require('./publish');
const { factChunkCache, rawChunks, rawRecords, reportBackend } = require('./report-generate');
const { processReportJobs } = require('./report-worker');
const { ingestKnownSessions } = require('./session-ingest');
const { localDateKey } = require('./util');

async function sessions(opts = {}) {
  const cfg = config();
  const result = await ingestKnownSessions(cfg, true);
  process.stdout.write(`sessions changed=${result.changed} failures=${result.failures}\n`);
  if (opts.publish) publishSessionEvents(cfg, opts);
  return result;
}

// Runtimes without lifecycle hooks, such as DSH, rely on `onmhj schedule install` running this periodically.
async function catchup(opts = {}) {
  const cfg = config();
  const result = await ingestKnownSessions(cfg, true);
  writeInternalLog(cfg, 'catchup', { changed: result.changed, failures: result.failures });
  process.stdout.write(`catchup changed=${result.changed} failures=${result.failures}\n`);
  if (cfg.autoReport && cfg.repoPath) await processReportJobs(cfg, opts);
  if (cfg.reportPrefetch && cfg.reportPipeline === 'facts') await prefetchFacts(cfg).catch(err => writeInternalLog(cfg, 'report_prefetch_failed', errorDetails(err)));
  return result;
}

// Extracts facts for today's finished turns ahead of time; the nightly report then mostly reuses cached chunks.
async function prefetchFacts(cfg, deps = {}) {
  if (!cfg.repoPath) return;
  const lock = path.join(cfg.stateDir, 'locks', 'prefetch.lock');
  if (!acquireLock(lock)) return;
  try {
    const date = localDateKey(new Date(), cfg.timeZone);
    const prepared = prepareRaw(cfg, date, { write: false, pull: false });
    if (!prepared) return;
    const started = Date.now();
    const runBackend = reportBackend(cfg, deps);
    const { chunks } = await rawChunks(cfg, date, prepared.raw, DEFAULT_TARGET_BYTES, runBackend);
    const result = await prefetchExtraction({ records: rawRecords(prepared.raw), chunks, runPrompt: runBackend, chunkCache: factChunkCache(cfg, date) });
    writeInternalLog(cfg, 'report_prefetch', { date, chunks: chunks.length, facts: result.facts, cacheHits: result.cacheHits, seconds: Math.round((Date.now() - started) / 1000) });
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  catchup,
  sessions,
};
