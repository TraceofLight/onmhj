const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function normalizeTimeZone(timeZone) {
  const value = timeZone || systemTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return systemTimeZone();
  }
}

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function localDateKey(date = new Date(), timeZone = systemTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function previousLocalDateKey(date = new Date(), timeZone = systemTimeZone()) {
  return localDateKey(new Date(date.getTime() - 24 * 60 * 60 * 1000), timeZone);
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.replace(/\n$/, '') + '\n', { mode: 0o600 });
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function readJsonFromString(raw, fallback) {
  const parsed = parseJsonFromString(raw);
  return parsed.ok ? parsed.value : fallback;
}

function parseJsonFromString(raw) {
  try {
    return { ok: true, value: JSON.parse(String(raw || '').replace(/^\uFEFF/, '')) };
  } catch (err) {
    return { ok: false, value: null, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  appendLine,
  localDateKey,
  normalizeTimeZone,
  parseJsonFromString,
  previousLocalDateKey,
  readJson,
  readJsonFromString,
  readStdin,
  utcDateKey,
  writeJson,
};
