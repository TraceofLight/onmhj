'use strict';

// Task Markdown contract shared by writing, verification, and assembly: evidence markers, placeholders, URL stripping, parsing.

const { clip } = require('../report-util');

const EV_MARKER = /\s*\{\{ev:([^{}]*)\}\}\s*$/;

function bulletText(line) {
  return line.replace(EV_MARKER, '');
}

// Reports may not carry new links, so markdown links keep their text and bare URLs lose only the scheme (host and path stay readable).
function stripUrls(line) {
  return String(line)
    .replace(/\[([^\]\n]*)\]\(<?https?:\/\/[^)\s]*>?\)/g, '$1')
    .replace(/<(https?:\/\/[^\s>]+)>/g, '$1')
    .replace(/https?:\/\//g, '');
}

// The required-section placeholder and the variants models produce for it.
const PLACEHOLDER = '- 확인된 내용 없음';

const PLACEHOLDER_VARIANT = '- 확인된 내용(?:이|은)? ?(?:없음|없다|없었다|없습니다)\\.?';

function parseTaskMarkdown(output, contract, number, factIds) {
  const lines = String(output || '').trim().replace(/^```(?:markdown)?\n|\n```$/g, '').split('\n')
    .map(stripUrls);
  if (!new RegExp(`^### T${number}\\. \\S`).test(lines[0] || '')) throw new Error(`first line must be ### T${number}. title`);
  if (lines.slice(1).some(line => /^#{1,3} /.test(line))) throw new Error('only #### subsections are allowed after the title');
  let previous = -1;
  for (const section of contract.taskSections) {
    const indexes = lines.flatMap((line, index) => (line.trim() === `#### ${section}` ? [index] : []));
    if (indexes.length !== 1) throw new Error(`section must appear once: ${section}`);
    if (indexes[0] < previous) throw new Error(`section order invalid: ${section}`);
    previous = indexes[0];
  }
  const allowed = new Set([...contract.taskSections, contract.followUp]);
  const unknown = lines.find(line => line.startsWith('#### ') && !allowed.has(line.slice(5).trim()));
  if (unknown) throw new Error(`unexpected section: ${unknown}`);
  const known = new Set(factIds);
  const bullets = [];
  lines.forEach((line, index) => {
    if (!/^\s*(- |\d+\. )/.test(line)) return;
    if (new RegExp(`^\\s*${PLACEHOLDER_VARIANT}\\s*$`).test(line)) return;
    const match = line.match(EV_MARKER);
    if (!match) throw new Error(`bullet without {{ev:...}} marker: ${clip(line, 80)}`);
    const ids = match[1].split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length || ids.some(id => !known.has(id))) throw new Error(`unknown fact id in marker: ${match[1]}`);
    bullets.push({ index, ids });
  });
  if (!bullets.length) throw new Error('task has no cited bullets');
  return { lines: lines.map(line => line.replace(/\s+$/, '')), bullets };
}

module.exports = {
  EV_MARKER,
  bulletText,
  stripUrls,
  PLACEHOLDER,
  PLACEHOLDER_VARIANT,
  parseTaskMarkdown,
};
