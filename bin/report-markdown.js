'use strict';

// GFM renders text between two "~" as strikethrough, so range marks like "1~2" must be escaped in reports.
const PROTECTED_OR_TILDE = /(`[^`\n]*`|https?:\/\/[^\s)>\]]+)|(?<!\\)~/g;
const FENCE = /^\s*(```|~~~)/;

function escapeLine(line) {
  return line.replace(PROTECTED_OR_TILDE, (match, protectedText) => protectedText || '\\~');
}

// Escapes "~" as "\~" outside fenced code, inline code, and URLs. Idempotent.
function escapeReportTildes(markdown) {
  let inFence = false;
  return String(markdown).split('\n').map(line => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : escapeLine(line);
  }).join('\n');
}

module.exports = { escapeReportTildes };
