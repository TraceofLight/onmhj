'use strict';

// Stage 6: reference placement, task finalization, and grounded one-line summaries.

const { parseJsonObject, mapLimit } = require('../report-util');
const { EV_MARKER, bulletText, PLACEHOLDER, PLACEHOLDER_VARIANT } = require('./task-markdown');

// Each reference goes to the task holding the most facts from the turn that cited it (earliest task on ties).
function referenceTasks(tasks, factsById, turnsByKey) {
  const owners = new Map();
  const seen = new Set();
  const turnKeys = [...new Set(tasks.flatMap(task => task.factIds.map(id => factsById.get(id).turn)))];
  for (const key of turnKeys) {
    const counts = tasks.map(task => task.factIds.filter(id => factsById.get(id).turn === key).length);
    const owner = counts.indexOf(Math.max(...counts));
    for (const reference of (turnsByKey.get(key) || {}).references || []) {
      if (!reference || !reference.url || seen.has(reference.url)) continue;
      seen.add(reference.url);
      if (!owners.has(owner)) owners.set(owner, []);
      owners.get(owner).push(reference);
    }
  }
  return owners;
}

// Removes evidence markers and normalizes spacing; empty required sections get the contract placeholder.
function finalizeTask(written, contract, referenceLines) {
  const required = new Set(contract.taskSections);
  const out = [];
  let section = null;
  let count = 0;
  const close = () => {
    if (section && required.has(section) && !count) out.push('- 확인된 내용 없음');
  };
  for (const raw of written.lines) {
    const line = raw.replace(EV_MARKER, '').replace(/\s*\{\{ev:[^{}]*\}\}/g, '').replace(/\s+$/, '')
      .replace(new RegExp(`^${PLACEHOLDER_VARIANT}$`), PLACEHOLDER);
    if (!line.trim()) continue;
    if (line.startsWith('#### ')) {
      close();
      section = line.slice(5).trim();
      count = 0;
      out.push('', line, '');
    } else if (line.startsWith('### ')) {
      out.push(line);
    } else {
      out.push(line);
      count++;
    }
  }
  close();
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return referenceLines.length ? `${body}\n\n#### ${contract.references}\n\n${referenceLines.join('\n')}` : body;
}

function bulletTime(item, bullet, factsById) {
  return bullet.ids.map(id => (factsById.get(id) || {}).time || '').sort().pop().slice(11, 16);
}

function summaryPrompt(item, factsById) {
  return [
    '다음은 하루 작업 보고서의 Task 하나다. 맨 앞 요약에 쓸 줄을 하나 골라라.',
    '- 이 Task가 하루 끝에 도달한 최종 상태와 핵심 결과를 보여 주는 줄을 고른다. 처음에 실패했다가 나중에 해결됐다면 해결된 줄을 고른다. 초기 상태, 중간 실패, 지엽적인 세부 줄은 고르지 않는다.',
    '- 대괄호 안 시각이 늦은 결과 줄이 최종 상태일 가능성이 높다.',
    '- 새 문장을 쓰지 말고 줄 번호만 고른다. 출력은 JSON 하나만: {"pick":[줄 번호]}',
    `--- ${item.lines[0]} ---`,
    ...item.bullets.map(bullet => `${bullet.index}| [${bulletTime(item, bullet, factsById)}] ${bulletText(item.lines[bullet.index])}`),
  ].join('\n');
}

// Fallback: the latest result line backed only by confirmed facts, else the latest result line.
function latestResultBullet(item, factsById) {
  const start = item.lines.findIndex(line => /^#### 결과/.test(line));
  const end = item.lines.findIndex((line, i) => i > start && line.startsWith('#### '));
  const results = item.bullets.filter(b => b.index > start && (end < 0 || b.index < end));
  const time = bullet => bullet.ids.map(id => (factsById.get(id) || {}).time || '').sort().pop();
  const confirmed = results.filter(b => b.ids.every(id => (factsById.get(id) || {}).status === '확인'));
  const pool = confirmed.length ? confirmed : results;
  const bullet = [...pool].sort((a, b) => time(a).localeCompare(time(b))).pop() || item.bullets[0];
  return bullet ? [bullet.index] : [];
}

function sentencePrompt(item) {
  return [
    '다음 Task 본문만 보고 하루 요약에 들어갈 짧은 한 문장을 써라. 제목 뒤에 붙으므로 제목을 반복하지 않는다.',
    '- 어떤 상태로 끝났는지(결론이나 최종 결과)를 쓴다. 조사·질문이었다면 결론만 쓴다. 80자 안팎으로 쓴다.',
    '- 본문에 없는 내용이나 수치는 쓰지 않는다. 본문이 "추정", "예상", "권고", "보인다", "미확인"으로 쓴 내용은 그 표현을 유지하고 "확인했다", "확정했다", "규명했다"로 바꾸지 않는다.',
    '- "결정이나 후속 작업은 없다" 같은 빈 칸 설명은 쓰지 않는다.',
    '- 한국어 평서문 한 문장만 출력한다. 목록 기호, 따옴표, 다른 설명은 쓰지 않는다.',
    '--- Task ---',
    ...item.lines.map(line => bulletText(line)).filter(line => line.trim()),
  ].join('\n');
}

// A generated sentence is accepted only if it is one line and every number and code value in it appears in the task text.
function acceptSentence(output, item) {
  const sentence = String(output || '').trim().replace(/^[-*]\s*/, '').replace(/^["“]|["”]$/g, '').trim();
  if (!sentence || /\n/.test(sentence) || /https?:\/\/|\{\{/.test(sentence) || sentence.length > 200) return '';
  const body = item.lines.map(line => bulletText(line)).join('\n');
  // Confirmation verbs absent from the task text would upgrade estimates; such sentences are rejected.
  const strong = sentence.match(/(확인했|확정했|확정되|규명했|규명하|결론 지|결론지)/g) || [];
  if (strong.some(verb => !body.includes(verb))) return '';
  const values = [...(sentence.match(/`[^`\n]+`/g) || []), ...(sentence.replace(/`[^`\n]*`/g, ' ').match(/\d[\d,.]*\d|\d/g) || [])]
    .map(value => value.replace(/`/g, ''));
  return values.every(value => body.includes(value)) ? sentence : '';
}

// The summary is one grounded sentence per task; if it cannot be validated, the best verified task line is reused.
async function writeSummary({ written, factsById, runPrompt }) {
  const lines = await mapLimit(written, 3, async item => {
    const title = item.lines[0].replace(/^### T\d+\. /, '');
    try {
      const sentence = acceptSentence(await runPrompt(sentencePrompt(item)), item);
      if (sentence) return `- ${title}: ${sentence}`;
    } catch {}
    const valid = new Set(item.bullets.map(bullet => bullet.index));
    let chosen = [];
    try {
      const pick = parseJsonObject(await runPrompt(summaryPrompt(item, factsById))).pick;
      chosen = (Array.isArray(pick) ? pick : []).map(Number).filter(n => valid.has(n)).slice(0, 1);
    } catch {}
    const texts = (chosen.length ? chosen : latestResultBullet(item, factsById)).map(n => bulletText(item.lines[n]).replace(/^\s*(- |\d+\. )/, '').trim());
    return `- ${title}: ${texts.join(' ')}`.trim();
  });
  return lines.join('\n');
}

module.exports = {
  referenceTasks,
  finalizeTask,
  acceptSentence,
  writeSummary,
};
