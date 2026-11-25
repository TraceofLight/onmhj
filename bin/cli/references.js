const net = require('net');

const PRIVATE_REFERENCE_HOSTS = new net.BlockList();
for (const [network, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
]) PRIVATE_REFERENCE_HOSTS.addSubnet(network, prefix, type);

function redactSecrets(value) {
  return String(value)
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|SG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|private[_-]?key)\b(\s*[:=]\s*)(['"]?)[^\s'"`,;]+/gi, (_match, key, sep, quote) => `${key}${sep}${quote}[REDACTED]`);
}

function isPrivateReferenceHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|lan|home|invalid|test)$/.test(host)) return true;
  const version = net.isIP(host);
  return Boolean(version && PRIVATE_REFERENCE_HOSTS.check(host, `ipv${version}`));
}

function normalizeReferenceUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.length > 2048) return '';
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateReferenceHost(url.hostname)) {
    return '';
  }
  const sensitive = /^(?:access_?token|api_?key|auth(?:orization)?|key|passw(?:or)?d|secret|sig(?:nature)?|token|x-amz-(?:credential|security-token|signature))$/i;
  if ([...url.searchParams.keys()].some(key => sensitive.test(key))) return '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.hash = '';
  return url.toString();
}

function mergeReferences(...groups) {
  const merged = new Map();
  for (const reference of groups.flat()) {
    if (!reference || typeof reference !== 'object') continue;
    const url = normalizeReferenceUrl(reference.url);
    if (!url) continue;
    const title = String(reference.title || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
    const current = merged.get(url);
    if (!current) merged.set(url, { title, url });
    else if (!current.title && title) current.title = title;
  }
  return [...merged.values()];
}

function trimReferenceToken(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    if (value[index] === ')') {
      if (!depth) return value.slice(0, index);
      depth -= 1;
    }
  }
  return value;
}

function extractExternalReferences(value) {
  const text = String(value || '');
  const references = [];
  // Consume each URL once so neither its path nor its Markdown syntax becomes another reference.
  const tokens = /(?:\[([^\]\n]+)\]\(<?)?(https?:\/\/[^\s<>"`\[\]]+)|\b(?:doi:\s*)?(10\.\d{4,9}\/[A-Z0-9._;()/:+-]+)/gi;
  for (const match of text.matchAll(tokens)) {
    let url = trimReferenceToken(match[2] || `https://doi.org/${match[3]}`);
    if (!match[1] && text[match.index - 1] !== '<') url = url.replace(/[.,;:!?}\]]+$/, '');
    if (!match[1] && text[match.index - 1] === "'") url = url.replace(/'$/, '');
    references.push({ title: match[1] || '', url });
  }
  return mergeReferences(references);
}

function sanitizeEvent(event) {
  const clean = { ...event };
  if (clean.prompt) clean.prompt = redactSecrets(clean.prompt);
  if (clean.promptPreview) clean.promptPreview = redactSecrets(clean.promptPreview);
  if (clean.assistantResponse) clean.assistantResponse = redactSecrets(clean.assistantResponse);
  if (clean.assistantResponsePreview) clean.assistantResponsePreview = redactSecrets(clean.assistantResponsePreview);
  if (clean.event === 'AISessionTurn' && clean.assistantResponse) {
    const references = extractExternalReferences(clean.assistantResponse);
    if (references.length) clean.references = references;
    else delete clean.references;
  }
  return clean;
}

module.exports = {
  extractExternalReferences,
  mergeReferences,
  redactSecrets,
  sanitizeEvent,
};
