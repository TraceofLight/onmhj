'use strict';

// Small helpers shared by the report pipelines: text clipping, lenient JSON parsing, retries, bounded concurrency.

function clip(text, limit) {
  const value = String(text || '');
  return value.length > limit ? `${value.slice(0, limit)} …(생략)` : value;
}

function parseJsonObject(output) {
  const text = String(output || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

async function withRetry(build, parse, runPrompt, attempts = 2) {
  let feedback = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return parse(await runPrompt(build(feedback)));
    } catch (err) {
      feedback = err.message;
    }
  }
  throw new Error(`fact pipeline step failed: ${feedback}`);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

module.exports = {
  clip,
  parseJsonObject,
  withRetry,
  mapLimit,
};
