const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyFixes,
  buildEvidence,
  dedupeFollowUps,
  matchEvidenceIds,
  reviseReport,
  splitReport,
  splitTask,
  styleIssues,
  unverifiedValues,
  validateRevisedTask,
} = require('../bin/report-revise');

const contract = {
  summary: '오늘의 요약',
  tasks: '작업별 기록',
  taskSections: ['배경과 목적', '수행 과정', '결정', '결과'],
  followUp: '후속 작업',
  references: '참고 자료',
};

function task(number, title, extra = '') {
  return [
    `### T${number}. ${title}`,
    '',
    '#### 배경과 목적',
    '- 요청을 받았다.',
    '',
    '#### 수행 과정',
    '- 작업했다.',
    '',
    '#### 결정',
    '- 방향을 정했다.',
    '',
    '#### 결과',
    `- 커밋 \`abc1234\`을 반영했다.${extra}`,
  ].join('\n');
}

const draft = [
  '# 2026-11-22 뭐 했지',
  '',
  '## 오늘의 요약',
  '',
  '- 초안 요약',
  '',
  '## 작업별 기록',
  '',
  task(1, '서버 로그 정리'),
  '',
  '#### 참고 자료',
  '- [문서](https://example.com/doc)',
  '',
  '---',
  '',
  task(2, '위키 점검'),
  '',
].join('\n');

test('splits tasks and keeps the reference subsection out of the revisable body', () => {
  const { head, tasks } = splitReport(draft);
  assert.match(head, /## 작업별 기록/);
  assert.equal(tasks.length, 2);
  const { body, tail } = splitTask(tasks[0], contract);
  assert.ok(body.endsWith('을 반영했다.'));
  assert.match(tail, /^#### 참고 자료\n- \[문서\]/);
});

test('flags values missing from the evidence and style problems', () => {
  assert.deepEqual(unverifiedValues('커밋 `D4279D1`과 1,287건, 0.2779', '커밋 d4279d1 1287건 0.2779'), ['D4279D1']);
  const issues = styleIssues('- old counts는 when aggregated 상태로 hot path cold path를 거쳐 push419cf6a 했다 → 확인 → 반영. دان');
  assert.ok(issues.some(issue => issue.startsWith('번역하지 않은 영어 구절')));
  assert.ok(issues.some(issue => issue.includes('push419cf6a')));
  assert.ok(issues.some(issue => issue.startsWith('화살표')));
  assert.ok(issues.some(issue => issue.startsWith('한글·영문 외 문자')));
  assert.deepEqual(styleIssues('- `kubectl logs`로 Basalt 로그를 확인했다.'), []);
});

test('matches evidence through intermediate summary tasks and includes later turns', () => {
  const ids = matchEvidenceIds('서버 로그 정리 journald 보존', [
    { title: '서버 로그 정리', results: ['journald 보존 90일'], evidenceIds: ['s1:t1'] },
    { title: '양자역학 설명', results: ['파동함수'], evidenceIds: ['s2:t1'] },
  ]);
  assert.deepEqual(ids, ['s1:t1']);
  const evidence = buildEvidence([
    { sourceId: 's1:t1', sessionId: 's1', tsUtc: '1', prompt: '로그 정리', assistantResponse: '나중에 확인 필요' },
    { sourceId: 's1:t2', sessionId: 's1', tsUtc: '2', prompt: '확인했어?', assistantResponse: '확인 완료했다' },
    { sourceId: 's2:t1', sessionId: 's2', tsUtc: '1', prompt: '양자역학', assistantResponse: '설명' },
  ], ids);
  assert.match(evidence, /나중에 확인 필요/);
  assert.match(evidence, /뒤 턴 2[\s\S]*확인 완료했다/);
  assert.doesNotMatch(evidence, /양자역학/);
});

test('validates revised task structure and strips echoed links', () => {
  const revised = `${task(1, '로그 정리')}\n- [문서](https://example.com/doc) 기준으로 정리했다.\n\n#### 참고 자료\n- https://example.com/doc`;
  const value = validateRevisedTask(revised, contract, 1);
  assert.doesNotMatch(value, /https?:|참고 자료/);
  assert.match(value, /- 문서 기준으로 정리했다\./);
  assert.throws(() => validateRevisedTask(task(2, '번호 변경'), contract, 1), /heading changed/);
  assert.throws(() => validateRevisedTask(task(1, '결과 누락').replace('#### 결과', '#### 결론'), contract, 1), /section count invalid: 결과/);
});

test('revises every task, keeps references, and falls back to the draft on repeated failure', async () => {
  const records = [
    { sourceId: 's1:t1', sessionId: 's1', tsUtc: '1', prompt: '서버 로그 정리', assistantResponse: '커밋 abc1234' },
    { sourceId: 's2:t1', sessionId: 's2', tsUtc: '1', prompt: '위키 점검', assistantResponse: '커밋 abc1234' },
  ];
  const summaryTasks = [
    { title: '서버 로그 정리', evidenceIds: ['s1:t1'] },
    { title: '위키 점검', evidenceIds: ['s2:t1'] },
  ];
  const prompts = [];
  const result = await reviseReport({
    report: draft,
    records,
    summaryTasks,
    contract,
    concurrency: 1,
    runPrompt: async prompt => {
      prompts.push(prompt);
      if (prompt.startsWith('다음은 하루 작업 보고서')) return '- 로그를 정리했다.\n- 위키를 점검했다.';
      if (prompt.includes('### T1.')) return task(1, '서버 로그 정리', ' 정리를 마쳤다.');
      return 'invalid';
    },
  });

  assert.deepEqual(result.tasks.map(item => item.revised), [true, false]);
  assert.match(result.report, /## 오늘의 요약\n\n- 로그를 정리했다\.\n- 위키를 점검했다\.\n\n## 작업별 기록/);
  assert.match(result.report, /정리를 마쳤다\.\n\n#### 참고 자료\n- \[문서\]\(https:\/\/example\.com\/doc\)/);
  assert.match(result.report, /### T2\. 위키 점검/);
  assert.equal(prompts.filter(prompt => prompt.startsWith('너는') && prompt.includes('### T2.')).length, 3);
});

test('restores summary tasks the draft dropped as new tasks with their own evidence', async () => {
  const records = [
    { sourceId: 's1:t1', sessionId: 's1', tsUtc: '1', prompt: '서버 로그 정리', assistantResponse: '커밋 abc1234' },
    { sourceId: 's2:t1', sessionId: 's2', tsUtc: '1', prompt: '위키 점검', assistantResponse: '커밋 abc1234' },
    { sourceId: 's3:t1', sessionId: 's3', tsUtc: '1', prompt: '영구 키 발급', assistantResponse: '키 발급 완료' },
  ];
  const summaryTasks = [
    { title: '서버 로그 정리', results: ['정리'], evidenceIds: ['s1:t1'] },
    { title: '위키 점검', results: ['점검'], evidenceIds: ['s2:t1'] },
    { title: '영구 키 발급', background: ['키 요청'], results: ['발급 완료'], followUps: ['배포'], evidenceIds: ['s3:t1'] },
  ];
  const revisePrompts = [];
  const result = await reviseReport({
    report: draft,
    records,
    summaryTasks,
    contract,
    concurrency: 1,
    runPrompt: async prompt => {
      if (prompt.startsWith('아래 "중간 요약 항목"')) return '{"assign":[1,2,0]}';
      if (prompt.startsWith('다음은 하루 작업 보고서')) return '- 요약';
      revisePrompts.push(prompt);
      const number = Number(prompt.match(/`### T(\d+)\. 제목`/)[1]);
      return task(number, `수정 ${number}`, ' 확인했다.');
    },
  });

  assert.deepEqual(result.tasks.map(item => item.added), [false, false, true]);
  assert.equal(result.assignment, 'model');
  assert.match(result.report, /### T3\. 수정 3/);
  const added = revisePrompts.find(prompt => prompt.includes('### T3. 영구 키 발급'));
  assert.match(added, /- 키 요청[\s\S]*#### 후속 작업\n- 배포/);
  assert.match(added, /영구 키 발급[\s\S]*키 발급 완료/);
  assert.doesNotMatch(added.slice(added.indexOf('--- 근거')), /위키 점검/);
});

test('falls back to lexical evidence matching when the assignment is invalid', async () => {
  const result = await reviseReport({
    report: draft,
    records: [{ sourceId: 's1:t1', sessionId: 's1', tsUtc: '1', prompt: '서버 로그 정리', assistantResponse: '완료' }],
    summaryTasks: [{ title: '서버 로그 정리', evidenceIds: ['s1:t1'] }],
    contract,
    concurrency: 1,
    runPrompt: async prompt => (prompt.startsWith('아래') ? '{"assign":[5]}' : 'invalid'),
  });
  assert.equal(result.assignment, 'lexical');
  assert.deepEqual(result.tasks.map(item => item.added), [false, false]);
});

test('applies verifier fixes only to exact non-heading lines', () => {
  const body = task(1, '로그 정리');
  const output = JSON.stringify({ fixes: [
    { line: '- 방향을 정했다.', replacement: '- 방향을 권고했다.' },
    { line: '### T1. 로그 정리', replacement: '### T1. 바뀐 제목' },
    { line: '- 없는 줄', replacement: '- 무시' },
    { line: '- 작업했다.', replacement: '' },
  ] });
  const { body: fixed, applied } = applyFixes(body, `검증 결과 ${output}`);
  assert.equal(applied, 2);
  assert.match(fixed, /^### T1\. 로그 정리/);
  assert.match(fixed, /- 방향을 권고했다\./);
  assert.doesNotMatch(fixed, /- 작업했다\./);
  assert.match(fixed, /#### 수행 과정\n\n#### 결정/);
});

test('removes follow-ups repeated across tasks', () => {
  const withFollowUp = (number, items) => `${task(number, `작업 ${number}`)}\n\n#### 후속 작업\n${items.map(item => `- ${item}`).join('\n')}`;
  const [first, second] = dedupeFollowUps([
    withFollowUp(1, ['NetBird 업그레이드 진행']),
    withFollowUp(2, ['`NetBird` 업그레이드 진행', 'Traefik 용량 확인', 'Windows NetBird 업그레이드 진행']),
  ], contract);
  assert.match(first, /NetBird 업그레이드 진행/);
  assert.doesNotMatch(second, /- `NetBird` 업그레이드 진행/);
  assert.match(second, /#### 후속 작업\n- Traefik 용량 확인\n- Windows NetBird 업그레이드 진행/);
  const [, emptied] = dedupeFollowUps([withFollowUp(1, ['같은 일']), withFollowUp(2, ['같은 일'])], contract);
  assert.doesNotMatch(emptied, /후속 작업/);
});

test('passes dropped items that belong to an existing task into its revision prompt', async () => {
  const prompts = [];
  const result = await reviseReport({
    report: draft,
    records: [
      { sourceId: 's1:t1', sessionId: 's1', tsUtc: '1', prompt: '서버 로그 정리', assistantResponse: '완료' },
      { sourceId: 's1:t2', sessionId: 's1', tsUtc: '2', prompt: 'SSH 키 이전', assistantResponse: '이전 완료' },
    ],
    summaryTasks: [
      { title: '서버 로그 정리', evidenceIds: ['s1:t1'] },
      { title: 'SSH 키 이전', results: ['이전 완료'], evidenceIds: ['s1:t2'] },
    ],
    contract,
    concurrency: 1,
    runPrompt: async prompt => {
      if (prompt.startsWith('아래 "중간 요약 항목"')) return '{"assign":[1,-1]}';
      prompts.push(prompt);
      return 'invalid';
    },
  });
  assert.deepEqual(result.tasks.map(item => item.extras), [1, 0]);
  const first = prompts.find(prompt => prompt.includes('### T1. 서버 로그 정리'));
  assert.match(first, /--- 이 Task에 반영해야 하는 누락 항목 ---\n- SSH 키 이전\n  - 이전 완료/);
  assert.match(first, /--- 다른 Task 목록 ---\nT2\. 위키 점검/);
});
