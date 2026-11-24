const assert = require('node:assert/strict');
const test = require('node:test');

const {
  attachMissing,
  buildTurns,
  deterministicFlags,
  finalizeTask,
  generateFactReport,
  parseExtraction,
  parseAssign,
  parseGoals,
  parseTaskMarkdown,
  placeByKind,
  polishTask,
  pruneSuperseded,
  reassignFacts,
  referenceTasks,
  reviewFacts,
  voteAssignments,
} = require('../bin/report-facts');

const contract = {
  title: '뭐 했지',
  summary: '오늘의 요약',
  tasks: '작업별 기록',
  taskSections: ['배경과 목적', '수행 과정', '결정', '결과'],
  followUp: '후속 작업',
  references: '참고 자료',
};

const records = [
  { sourceId: 's1:a', sessionId: 's1', tsUtc: '2026-11-14T01:00:00Z', prompt: '로그 보존 기간을 정해줘', assistantResponse: '90일로 설정했고 커밋 abc1234를 push했다.', references: [{ title: '문서', url: 'https://example.com/doc' }] },
  { sourceId: 's1:b', sessionId: 's1', tsUtc: '2026-11-14T02:00:00Z', prompt: '아까 30일이라고 한 거 90일 맞지?', assistantResponse: '네, 90일이 맞습니다. 재시작 후 적용될 것입니다.' },
  { sourceId: 's2:a', sessionId: 's2', tsUtc: '2026-11-14T03:00:00Z', prompt: '양자역학 설명해줘', assistantResponse: '파동함수와 불확정성 원리를 설명했다.' },
];

test('validates extracted facts and keeps only values present in the turn', () => {
  const turns = buildTurns(records);
  const output = JSON.stringify({
    facts: [{ turn: 't1', target: '서버', topic: '로그', kind: '결과', status: '확인', text: '보존 기간을 90일로 설정했다.', values: ['abc1234', 'zzz9999'] }],
    resolved: [{ id: 'f9', turn: 't1' }, { id: 'f1', turn: 't1', how: '완료' }],
    corrections: [{ wrong: '30일', correct: '90일', turn: 't2' }],
  });
  const parsed = parseExtraction(output, turns.slice(0, 2), [{ id: 'f1', text: '보존 기간 결정' }]);
  assert.deepEqual(parsed.facts[0].values, ['abc1234']);
  assert.deepEqual(parsed.resolved.map(item => item.id), ['f1']);
  assert.equal(parsed.corrections[0].correct, '90일');
  assert.throws(() => parseExtraction('{"facts":[{"turn":"t9","kind":"결과","status":"확인","text":"x"}]}', turns, []), /turn must be one of/);
  assert.throws(() => parseExtraction('{"facts":[{"turn":"t1","kind":"결과","status":"아마","text":"x"}]}', turns, []), /status/);
});

test('assigns facts to planned goals and attaches a few invalid assignments by turn', () => {
  const facts = [
    { id: 'f1', turn: 't1', session: 's1' },
    { id: 'f2', turn: 't1', session: 's1' },
    { id: 'f3', turn: 't3', session: 's2' },
  ];
  const goals = parseGoals('{"goals":[{"title":"T1. 로그","description":"로그 보존"},{"title":"설명"}]}');
  assert.deepEqual(goals.map(goal => goal.title), ['로그', '설명']);
  const assigned = parseAssign('{"assign":{"f1":1,"f2":7,"f3":"2"}}', goals, facts);
  assert.deepEqual([...assigned], [['f1', 1], ['f3', 2]]);
  const tasks = [{ title: '로그', factIds: ['f1'] }, { title: '설명', factIds: ['f3'] }];
  assert.deepEqual(attachMissing(tasks, [facts[1]], facts).map(task => task.factIds), [['f1', 'f2'], ['f3']]);
  assert.throws(() => parseAssign('{"assign":[1,2,3]}', goals, facts), /object of id/);
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `f${i + 1}`, turn: 't1', session: 's1' }));
  assert.throws(() => parseAssign('{"assign":{"f1":1}}', goals, many), /missing 49 of 50 ids/);
  assert.throws(() => parseGoals('{"goals":[]}'), /non-empty/);
});

const taskOutput = [
  '### T1. 로그 보존 설정',
  '#### 배경과 목적',
  '- 로그 보존 기간을 정하려 했다. {{ev:f1}}',
  '#### 수행 과정',
  '- 확인된 내용 없음',
  '#### 결정',
  '- 보존 기간을 90일로 정했다. {{ev:f2}}',
  '#### 결과',
  '- 재시작 후 적용을 확인했다. {{ev:f3}}',
  '- 커밋 `abc1234`, `ffff000`을 반영했고 30일 기준이다. {{ev:f2}}',
].join('\n');

test('parses cited task markdown and rejects uncited bullets', () => {
  const parsed = parseTaskMarkdown(taskOutput, contract, 1, ['f1', 'f2', 'f3']);
  assert.deepEqual(parsed.bullets.map(bullet => bullet.ids), [['f1'], ['f2'], ['f3'], ['f2']]);
  assert.throws(() => parseTaskMarkdown(taskOutput.replace(' {{ev:f1}}', ''), contract, 1, ['f1', 'f2', 'f3']), /without \{\{ev/);
  assert.throws(() => parseTaskMarkdown(taskOutput, contract, 1, ['f1', 'f2']), /unknown fact id/);
  assert.throws(() => parseTaskMarkdown(taskOutput.replace('#### 결정\n', ''), contract, 1, ['f1', 'f2', 'f3']), /section must appear once: 결정/);
});

test('flags confirmation verbs on expectations, superseded values, and unsupported values', () => {
  const turns = buildTurns(records);
  const written = parseTaskMarkdown(taskOutput, contract, 1, ['f1', 'f2', 'f3']);
  const factsById = new Map([
    ['f1', { id: 'f1', turn: 't1', status: '확인', text: '요청', values: [] }],
    ['f2', { id: 'f2', turn: 't1', status: '확인', text: '90일 설정', values: ['abc1234'] }],
    ['f3', { id: 'f3', turn: 't2', status: '예상', text: '재시작 후 적용될 것', values: [] }],
  ]);
  const flags = deterministicFlags(written, factsById, new Map(turns.map(turn => [turn.key, turn])), [{ wrong: '30일', correct: '90일' }]);
  const problemsFor = start => flags.find(flag => written.lines[flag.index].startsWith(start)).problems.map(problem => problem.text).join(' / ');
  assert.match(problemsFor('- 재시작'), /예상인데 확인·완료 동사/);
  assert.match(problemsFor('- 커밋'), /정정 전 값 "30일"[\s\S]*근거에 없는 값: ffff000/);
  assert.equal(flags.length, 2);
});

test('finalizes a task without markers and fills empty required sections', () => {
  const written = parseTaskMarkdown(taskOutput.replace('- 확인된 내용 없음\n', '').replace('정하려 했다.', '정하려 했다 {{ev:f1}} 는 요청이었다.'), contract, 1, ['f1', 'f2', 'f3']);
  const body = finalizeTask(written, contract, ['- [문서](https://example.com/doc)']);
  assert.doesNotMatch(body, /\{\{ev:/);
  assert.match(body, /^### T1\. 로그 보존 설정\n\n#### 배경과 목적\n\n- 로그 보존 기간을 정하려 했다 는 요청이었다\.\n\n#### 수행 과정\n\n- 확인된 내용 없음\n\n#### 결정/);
  assert.match(body, /#### 참고 자료\n\n- \[문서\]\(https:\/\/example\.com\/doc\)$/);
});

test('generates a cited, verified report end to end with a scripted model', async () => {
  const stats = [];
  const report = await generateFactReport({
    date: '2026-11-14',
    records,
    chunks: [{ evidenceIds: ['s1:a', 's1:b'] }, { evidenceIds: ['s2:a'] }],
    contract,
    title: contract.title,
    concurrency: 1,
    renderReference: reference => `[${reference.title}](${reference.url})`,
    log: value => stats.push(value),
    runPrompt: async prompt => {
      if (prompt.startsWith('너는 AI 작업 세션 기록에서')) {
        if (prompt.includes('[t3 ')) {
          return JSON.stringify({ facts: [{ turn: 't3', target: '개념', topic: '양자역학', kind: '결과', status: '확인', text: '파동함수를 설명했다.', values: [] }] });
        }
        return JSON.stringify({
          facts: [
            { turn: 't1', target: '서버', topic: '로그', kind: '요청', status: '확인', text: '보존 기간 결정을 요청했다.', values: [] },
            { turn: 't1', target: '서버', topic: '로그', kind: '결과', status: '확인', text: '90일로 설정하고 push했다.', values: ['abc1234'] },
            { turn: 't2', target: '서버', topic: '로그', kind: '후속', status: '예상', text: '재시작 후 적용될 것이다.', values: [] },
          ],
          corrections: [{ wrong: '30일', correct: '90일', turn: 't2' }],
        });
      }
      if (prompt.startsWith('아래는 하루 동안의 대화 턴')) return '{"goals":[{"title":"로그 보존 설정","description":"보존 기간"},{"title":"양자역학 설명","description":"개념"}]}';
      if (prompt.startsWith('각 대화 턴이 어느 작업 목표에')) return '{"assign":{"t1":1,"t2":1,"t3":2}}';
      if (prompt.startsWith('너는 사실 분류 검토자다')) return '{"facts":[]}';
      if (prompt.startsWith('너는 하루 작업 보고서의 Task')) {
        const number = Number(prompt.match(/`### T(\d+)\. 제목`/)[1]);
        return number === 1
          ? '### T1. 로그 보존 설정\n#### 배경과 목적\n- 보존 기간 결정을 요청했다. {{ev:f1}}\n#### 수행 과정\n- 확인된 내용 없음\n#### 결정\n- 확인된 내용 없음\n#### 결과\n- 90일로 설정하고 커밋 `abc1234`를 push했다. {{ev:f2}}\n#### 후속 작업\n- 재시작 후 적용을 확인했다. {{ev:f3}}'
          : '### T2. 양자역학 설명\n#### 배경과 목적\n- 확인된 내용 없음\n#### 수행 과정\n- 확인된 내용 없음\n#### 결정\n- 확인된 내용 없음\n#### 결과\n- 파동함수를 설명했다. {{ev:f4}}';
      }
      if (prompt.startsWith('너는 작업 보고서 검증자다')) {
        const line = prompt.split('\n').find(row => row.includes('재시작 후 적용을 확인했다'));
        return line ? JSON.stringify({ fixes: [{ n: Number(line.split(' | ')[0]), replacement: '- 재시작 후 적용될 예정이다. {{ev:f3}}' }] }) : '{"fixes":[]}';
      }
      if (prompt.startsWith('다음은 하루 작업 보고서')) {
        assert.doesNotMatch(prompt, /\{\{ev:/);
        return 'not json';
      }
      throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`);
    },
  });

  assert.match(report, /^# 2026-11-14 뭐 했지\n\n## 오늘의 요약\n\n- 로그 보존 설정: 90일로 설정하고 커밋 `abc1234`를 push했다\.\n- 양자역학 설명: 파동함수를 설명했다\.\n\n## 작업별 기록\n\n### T1\. 로그 보존 설정/);
  assert.match(report, /#### 후속 작업\n\n- 재시작 후 적용될 예정이다\.\n\n#### 참고 자료\n\n- \[문서\]\(https:\/\/example\.com\/doc\)/);
  assert.doesNotMatch(report, /\{\{ev:/);
  assert.match(report, /### T2\. 양자역학 설명/);
  assert.deepEqual(
    { facts: stats[0].facts, tasks: stats[0].tasks, corrections: stats[0].corrections, flags: stats[0].flags, fixes: stats[0].fixes, remainingFlags: stats[0].remainingFlags },
    { facts: 4, tasks: 2, corrections: 1, flags: 1, fixes: 1, remainingFlags: 0 },
  );
  assert.deepEqual(stats[0].rules, { status: { flagged: 1, changed: 1 } }
  );
});

test('moves bullets to the section of their facts kind and keeps ties in place', () => {
  const written = parseTaskMarkdown(taskOutput, contract, 1, ['f1', 'f2', 'f3']);
  const factsById = new Map([
    ['f1', { id: 'f1', kind: '요청' }],
    ['f2', { id: 'f2', kind: '결과' }],
    ['f3', { id: 'f3', kind: '후속' }],
  ]);
  const placed = placeByKind(written, contract, factsById);
  assert.match(placed, /#### 결정\n- 확인된 내용 없음\n#### 결과\n- 보존 기간을 90일로 정했다\. \{\{ev:f2\}\}\n- 커밋/);
  assert.match(placed, /#### 후속 작업\n- 재시작 후 적용을 확인했다\. \{\{ev:f3\}\}$/);
  assert.match(placed, /#### 수행 과정\n- 확인된 내용 없음/);
});

test('applies valid kind and status corrections from the review and ignores the rest', async () => {
  const facts = [
    { id: 'f1', kind: '결과', status: '확인', text: '원인은 차단으로 보인다' },
    { id: 'f2', kind: '결정', status: '확인', text: '드라이버를 설치했다' },
  ];
  const { facts: reviewed, changed } = await reviewFacts({
    facts,
    turns: buildTurns(records),
    runPrompt: async () => '{"facts":[{"id":"f1","kind":"결과","status":"예상"},{"id":"f2","kind":"행동","status":"확인"},{"id":"f9","kind":"결과","status":"확인"}]}',
  });
  assert.equal(changed, 1);
  assert.deepEqual(reviewed.map(fact => `${fact.kind}/${fact.status}`), ['결과/예상', '결정/확인']);
  assert.equal(facts[0].status, '확인');
  const failed = await reviewFacts({ facts, turns: [], runPrompt: async () => 'not json' });
  assert.equal(failed.changed, 0);
});

test('keeps only polished lines whose code, numbers, and markers are unchanged', async () => {
  const written = {
    lines: ['### T1. 제목', '#### 결과', '- Dual GPU 인식 확인함, `abc1234` 반영 {{ev:f1}}', '- 90일 설정 {{ev:f2}}', '- 확인된 내용 없음'],
  };
  const { written: polished, changed } = await polishTask({
    written,
    runPrompt: async () => [
      '0| ### T1. 바뀐 제목',
      '2| - 두 GPU를 인식했고 `abc1234`를 반영했다. {{ev:f1}}',
      '3| - 보존 기간을 30일로 설정했다. {{ev:f2}}',
      '4| 확인된 내용 없음',
    ].join('\n'),
  });
  assert.equal(changed, 1);
  assert.deepEqual(polished.lines, ['### T1. 제목', '#### 결과', '- 두 GPU를 인식했고 `abc1234`를 반영했다. {{ev:f1}}', '- 90일 설정 {{ev:f2}}', '- 확인된 내용 없음']);
});

test('attaches each reference to the task with the most facts from its turn', () => {
  const turns = buildTurns([
    { sourceId: 'a', tsUtc: '1', prompt: 'p', assistantResponse: 'r', references: [{ title: 'x', url: 'https://x.test' }] },
  ]);
  const factsById = new Map([
    ['f1', { id: 'f1', turn: 't1' }],
    ['f2', { id: 'f2', turn: 't1' }],
    ['f3', { id: 'f3', turn: 't1' }],
  ]);
  const owners = referenceTasks([{ factIds: ['f1'] }, { factIds: ['f2', 'f3'] }], factsById, new Map(turns.map(t => [t.key, t])));
  assert.deepEqual([...owners.keys()], [1]);
  assert.equal(owners.get(1)[0].url, 'https://x.test');
});

test('votes turn assignments across runs and breaks ties by the earliest answer', () => {
  const items = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  const result = voteAssignments(items, [
    new Map([['t1', 1], ['t2', 2]]),
    new Map([['t1', 2], ['t2', 2], ['t3', 3]]),
    new Map([['t1', 2], ['t2', 1]]),
  ]);
  assert.deepEqual([...result], [['t1', 2], ['t2', 2], ['t3', 3]]);
  assert.deepEqual([...voteAssignments(items, [new Map([['t1', 1]]), new Map([['t1', 2]])])], [['t1', 1]]);
});

test('places diagnosis under results and guidance under process, leaving corrections in place', () => {
  const written = parseTaskMarkdown([
    '### T1. 점검',
    '#### 배경과 목적',
    '- 점검을 요청했다. {{ev:f1}}',
    '#### 수행 과정',
    '- 확인된 내용 없음',
    '#### 결정',
    '- 원인은 슬롯 문제로 추정했다. {{ev:f2}}',
    '- BIOS 설정 점검을 안내했다. {{ev:f3}}',
    '- 접속 위치는 VM이었다. {{ev:f4}}',
    '#### 결과',
    '- 확인된 내용 없음',
  ].join('\n'), contract, 1, ['f1', 'f2', 'f3', 'f4']);
  const factsById = new Map([
    ['f1', { id: 'f1', kind: '요청' }],
    ['f2', { id: 'f2', kind: '진단' }],
    ['f3', { id: 'f3', kind: '안내' }],
    ['f4', { id: 'f4', kind: '정정' }],
  ]);
  const placed = placeByKind(written, contract, factsById);
  assert.match(placed, /#### 수행 과정\n- BIOS 설정 점검을 안내했다\. \{\{ev:f3\}\}\n#### 결정\n- 접속 위치는 VM이었다\. \{\{ev:f4\}\}\n#### 결과\n- 원인은 슬롯 문제로 추정했다\. \{\{ev:f2\}\}/);
  const turns = buildTurns(records);
  const parsed = parseExtraction(JSON.stringify({ facts: [
    { turn: 't1', kind: '판단', status: '예상', text: '원인을 추정했다.' },
    { turn: 't1', kind: '권고', status: '권고', text: '점검을 안내했다.' },
  ] }), turns, []);
  assert.deepEqual(parsed.facts.map(fact => fact.kind), ['진단', '안내']);
});

test('asks the model only about off-target facts and applies valid moves', async () => {
  const factsById = new Map([
    ['f1', { id: 'f1', target: 'GPU 서버', topic: 'GPU', text: 'GPU 진단' }],
    ['f2', { id: 'f2', target: 'GPU 서버', topic: 'GPU', text: 'GPU 결과' }],
    ['f3', { id: 'f3', target: 'DSH', topic: '설정', text: 'thinking 옵션 수정' }],
    ['f4', { id: 'f4', target: 'DSH', topic: '설정', text: '출력 상한 변경' }],
    ['f5', { id: 'f5', target: '기타', topic: '-', text: '잡담' }],
  ]);
  const prompts = [];
  const result = await reassignFacts({
    tasks: [{ title: 'GPU', factIds: ['f1', 'f2', 'f3', 'f5'] }, { title: 'DSH 설정', factIds: ['f4'] }],
    factsById,
    runPrompt: async prompt => {
      prompts.push(prompt);
      return '{"move":{"f3":2,"f1":2,"f9":1}}';
    },
  });
  assert.ok(result.candidates >= 1);
  assert.equal(result.moved, 1);
  assert.deepEqual(result.tasks.map(task => task.factIds), [['f1', 'f2', 'f5'], ['f4', 'f3']]);
  assert.match(prompts[0], /f3 \| 1 \| DSH/);
  assert.doesNotMatch(prompts[0], /f5 \|/);
});

test('drops only the URL scheme in written task lines instead of rejecting the task', () => {
  const parsed = parseTaskMarkdown(taskOutput.replace('- 보존 기간을 90일로 정했다.', '- 보존 기간을 https://example.com/doc 기준 90일로 정했다.'), contract, 1, ['f1', 'f2', 'f3']);
  assert.ok(parsed.lines.some(line => line === '- 보존 기간을 example.com/doc 기준 90일로 정했다. {{ev:f2}}'));
});

test('keeps inline code intact when stripping URL schemes and prunes only facts superseded by later ones', async () => {
  const parsed = parseTaskMarkdown(taskOutput.replace('- 보존 기간을 90일로 정했다.', '- `GET https://llm.example/v1/models`로 200을 받았고 `https://x.test`도 봤다.'), contract, 1, ['f1', 'f2', 'f3']);
  assert.ok(parsed.lines.includes('- `GET llm.example/v1/models`로 200을 받았고 `x.test`도 봤다. {{ev:f2}}'));
  const facts = [
    { id: 'f1', time: '2026-11-22T10:00:00', kind: '결과', status: '확인', text: 'journald 2.0GB', values: [] },
    { id: 'f2', time: '2026-11-22T11:00:00', kind: '결과', status: '확인', text: 'journald 1.9GB 재측정', values: [] },
    { id: 'f3', time: '2026-11-22T12:00:00', kind: '후속', status: '계획', text: '삭제 예정', values: [] },
  ];
  const { facts: kept, dropped } = await pruneSuperseded({
    facts,
    runPrompt: async () => '{"drop":[{"id":"f1","by":"f2"},{"id":"f3","by":"f1"},{"id":"f9","by":"f2"}]}',
  });
  assert.deepEqual(dropped, ['f1']);
  assert.deepEqual(kept.map(fact => fact.id), ['f2', 'f3']);
});

test('normalizes placeholder variants to the contract wording', () => {
  const written = parseTaskMarkdown(taskOutput.replace('- 확인된 내용 없음', '- 확인된 내용은 없었다.'), contract, 1, ['f1', 'f2', 'f3']);
  assert.match(finalizeTask(written, contract, []), /#### 수행 과정\n\n- 확인된 내용 없음\n/);
});
