'use strict';

// Stage 5: deterministic flags, model verification of cited lines, and conditional Korean polishing.

const { parseJsonObject } = require('../report-util');
const { EVIDENCE_TURN_CHARS } = require('./common');
const { renderTurn } = require('./turns');
const { EV_MARKER, bulletText, parseTaskMarkdown } = require('./task-markdown');

const CONFIRM_VERBS = /(확인했|확인됐|확인되었|완료했|완료됐|완료되었|채택했|확정했|적용했|측정했|검증했|해결했|배포했)/;

// Deterministic checks: confirmation verbs on unconfirmed facts, superseded values, values absent from cited sources.
function deterministicFlags(written, factsById, turnsByKey, corrections) {
  const flags = [];
  for (const bullet of written.bullets) {
    const line = written.lines[bullet.index];
    const text = bulletText(line);
    const facts = bullet.ids.map(id => factsById.get(id));
    const problems = [];
    if (facts.every(fact => fact.status !== '확인') && CONFIRM_VERBS.test(text)) {
      problems.push({ rule: 'status', text: `근거 사실이 ${[...new Set(facts.map(f => f.status))].join('/')}인데 확인·완료 동사를 썼다` });
    }
    for (const correction of corrections) {
      if (correction.wrong.length >= 2 && text.includes(correction.wrong) && !text.includes(correction.correct)) {
        problems.push({ rule: 'superseded', text: `정정 전 값 "${correction.wrong}"을 썼다(정정: ${correction.correct})` });
      }
    }
    const sources = facts.map(fact => `${fact.text}\n${fact.values.join('\n')}\n${(turnsByKey.get(fact.turn) || {}).prompt}\n${(turnsByKey.get(fact.turn) || {}).answer}`).join('\n');
    const values = [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1])
      .concat([...text.replace(/`[^`\n]*`/g, ' ').matchAll(/\b[0-9a-fA-F]{7,40}\b/g)].map(m => m[0]).filter(v => /\d/.test(v) && /[a-fA-F]/.test(v)));
    const unsupported = values.filter(value => !sources.includes(value));
    if (unsupported.length) problems.push({ rule: 'unsupported', text: `근거에 없는 값: ${unsupported.join(', ')}` });
    if (problems.length) flags.push({ index: bullet.index, problems });
  }
  return flags;
}

function verifyPrompt(written, flags) {
  const flagged = new Map(flags.map(flag => [flag.index, flag.problems.map(problem => problem.text)]));
  const turnText = written.turns.map(turn => renderTurn(turn, EVIDENCE_TURN_CHARS, false)).join('\n');
  return [
    '너는 작업 보고서 검증자다. 각 줄을 그 줄이 인용한 사실과 근거 턴에 대조해 다음 문제를 찾아 고쳐라.',
    '1. 근거가 예상, 추정, 권고, 계획, 미확인인 것을 확인, 완료, 채택, 확정, 측정한 사실처럼 쓴 줄',
    '2. 정정 전 값이나 근거와 다른 수치, 단위, 주체, 대상, 인과를 쓴 줄',
    '3. 근거에 없는 내용을 덧붙인 줄',
    '4. 비밀번호, 일회용 코드, 키, 토큰 원문이 들어간 줄(원문만 지운다)',
    '5. 0번 제목 줄이 근거보다 과장된 경우(확인되지 않은 해결, 해제, 규명 등). 제목을 고칠 때는 "### T번호. " 접두를 유지한다.',
    '- 자동 검사가 표시한 줄은 반드시 확인한다. 문제가 없는 줄은 출력하지 않는다.',
    '- 고친 줄도 끝의 {{ev:...}} 표시를 유지한다. 지울 줄은 replacement를 빈 문자열로 둔다.',
    '- 출력은 JSON 하나만: {"fixes":[{"n":줄 번호,"replacement":"고친 줄"}]}',
    '--- 줄 (번호 | 내용 | 인용 사실 | 자동 검사) ---',
    ...(/^### T\d+\. /.test(written.lines[0] || '') ? [`0 | ${written.lines[0]} | (제목) | -`] : []),
    ...written.bullets.map(bullet => {
      const facts = bullet.ids.map(id => written.facts.find(fact => fact.id === id)).filter(Boolean);
      return `${bullet.index} | ${written.lines[bullet.index]} | ${facts.map(f => `${f.id}(${f.status}) ${f.text}`).join(' / ')} | ${(flagged.get(bullet.index) || []).join('; ') || '-'}`;
    }),
    '--- 근거 턴 ---',
    turnText,
  ].join('\n');
}

// A title fix must keep the `### T<n>. ` prefix and stay on one line.
function isTitleFix(fix, number) {
  return Boolean(fix) && fix.n === 0 && typeof fix.replacement === 'string'
    && new RegExp(`^### T${number}\\. \\S`).test(fix.replacement) && !/\n/.test(fix.replacement);
}

// New text for a cited bullet (null deletes it), or undefined when the fix is invalid and must be ignored.
// A replacement must keep an evidence marker; the original indentation is preserved.
function bulletReplacement(fix, lines, bulletIndexes) {
  if (!fix || !bulletIndexes.has(fix.n) || typeof fix.replacement !== 'string' || /\n/.test(fix.replacement)) return undefined;
  if (fix.replacement && !EV_MARKER.test(fix.replacement)) return undefined;
  return fix.replacement ? fix.replacement.replace(/^\s*/, lines[fix.n].match(/^\s*/)[0]) : null;
}

function applyVerification(written, output, contract, number, factIds) {
  const fixes = parseJsonObject(output).fixes;
  if (!Array.isArray(fixes)) throw new Error('fixes must be an array');
  const lines = [...written.lines];
  const bulletIndexes = new Set(written.bullets.map(bullet => bullet.index));
  const changed = new Set();
  for (const fix of fixes) {
    if (isTitleFix(fix, number)) {
      if (fix.replacement !== lines[0]) {
        lines[0] = fix.replacement.trim();
        changed.add(0);
      }
      continue;
    }
    const replacement = bulletReplacement(fix, lines, bulletIndexes);
    if (replacement === undefined || replacement === lines[fix.n]) continue;
    lines[fix.n] = replacement;
    changed.add(fix.n);
  }
  const kept = lines.filter(line => line !== null);
  const parsed = parseTaskMarkdown(kept.join('\n'), contract, number, factIds);
  return { ...written, ...parsed, applied: changed.size, changed };
}

// Per detector: lines flagged and how many of them the verifier actually changed (a precision proxy).
function ruleStats(flags, changed) {
  const stats = {};
  for (const flag of flags) {
    for (const rule of new Set(flag.problems.map(problem => problem.rule))) {
      stats[rule] = stats[rule] || { flagged: 0, changed: 0 };
      stats[rule].flagged++;
      if (changed.has(flag.index)) stats[rule].changed++;
    }
  }
  return stats;
}

async function verifyTask({ written, contract, number, task, factsById, turnsByKey, corrections, runPrompt }) {
  const flags = deterministicFlags(written, factsById, turnsByKey, corrections);
  try {
    const verified = applyVerification(written, await runPrompt(verifyPrompt(written, flags)), contract, number, task.factIds);
    const remaining = deterministicFlags(verified, factsById, turnsByKey, corrections);
    return { ...verified, flags: flags.length, remaining: remaining.length, ruleStats: ruleStats(flags, verified.changed) };
  } catch {
    return { ...written, applied: 0, flags: flags.length, remaining: flags.length, ruleStats: ruleStats(flags, new Set()) };
  }
}

function protectedTokens(line) {
  const tokens = [
    ...(line.match(/`[^`\n]*`/g) || []),
    ...(line.match(EV_MARKER) || []).map(marker => marker.trim()),
    ...(line.replace(/`[^`\n]*`/g, ' ').match(/\d[\d,.]*/g) || []),
  ];
  return tokens.sort().join('\u0000');
}

function polishPrompt(lines) {
  return [
    '다음 보고서 Task의 한국어 문장만 다듬어라.',
    '- 어색한 번역투, 조사가 빠진 전보체, 끝없이 이어지는 문장, 오탈자, 일반 영어 단어, 과한 수동형("~되었다"), 반복되는 "AI가"를 자연스러운 한국어 평서문("~했다")으로 고친다.',
    '- 뜻, 사실, 확인·예상·권고 같은 확신 수준, 주체는 바꾸지 않는다. 백틱 안의 값, 숫자, 줄 끝 {{ev:...}} 표시는 글자 그대로 둔다.',
    '- 한글·영문이 아닌 문자가 섞여 깨진 낱말은 뜻이 분명하면 바로잡고(예: "دان와중고" → "다나와 중고"), 불분명하면 그 낱말만 지운다.',
    '- 줄 수와 순서, #으로 시작하는 제목 줄은 그대로 둔다. 각 줄을 "번호| 내용" 형식 그대로 출력하고 다른 말은 쓰지 않는다.',
    '--- Task ---',
    ...lines.map((line, i) => `${i}| ${line}`),
  ].join('\n');
}

// Polishing runs only when a task shows severe mixing; quoted text and inline code are ignored.
function needsPolish(written) {
  const text = written.lines.join('\n').replace(/`[^`\n]*`/g, ' ').replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
  return /[\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u0E00-\u0E7F]/.test(text)
    || /(?<![A-Za-z0-9_./-])[a-z]{2,}(?: [a-z]{2,}){3,}(?![A-Za-z0-9_/-])/.test(text);
}

// Line-level acceptance: a polished line is kept only if its protected tokens (code, numbers, markers) are unchanged.
async function polishTask({ written, runPrompt }) {
  try {
    const output = String(await runPrompt(polishPrompt(written.lines)) || '');
    const polished = new Map();
    for (const row of output.split('\n')) {
      const match = row.match(/^(\d+)\|\s?(.*)$/);
      if (match) polished.set(Number(match[1]), match[2].replace(/\s+$/, ''));
    }
    let changed = 0;
    const lines = written.lines.map((line, i) => {
      const next = polished.get(i);
      if (next === undefined || next === line || !next.trim() || line.startsWith('#') || next.startsWith('#')) return line;
      if (/^\s*(- |\d+\. )/.test(line) !== /^\s*(- |\d+\. )/.test(next)) return line;
      if (protectedTokens(line) !== protectedTokens(next)) return line;
      changed++;
      return next;
    });
    return { written: { ...written, lines }, changed };
  } catch {
    return { written, changed: 0 };
  }
}

module.exports = {
  deterministicFlags,
  applyVerification,
  verifyTask,
  needsPolish,
  polishTask,
};
