const assert = require('node:assert/strict');
const test = require('node:test');

const { escapeReportTildes } = require('../bin/report-markdown.js');
const { validateReport } = require('../bin/onmhj.js');

test('escapes tildes used as range marks', () => {
  assert.equal(
    escapeReportTildes('1/3~1/4 수준, 12:46~12:58 실측'),
    '1/3\\~1/4 수준, 12:46\\~12:58 실측',
  );
});

test('is idempotent and keeps existing escapes', () => {
  const once = escapeReportTildes('a~b ~~c~~');
  assert.equal(once, 'a\\~b \\~\\~c\\~\\~');
  assert.equal(escapeReportTildes(once), once);
});

test('leaves inline code, fenced code, and URLs untouched', () => {
  const input = [
    '`~/path` 와 5~6',
    '[논문](https://example.com/~htk/a.pdf) 1~2',
    '```',
    'cd ~/dir ~',
    '```',
    '~~~',
    'x~y',
    '~~~',
    '끝~끝',
  ].join('\n');
  const expected = [
    '`~/path` 와 5\\~6',
    '[논문](https://example.com/~htk/a.pdf) 1\\~2',
    '```',
    'cd ~/dir ~',
    '```',
    '~~~',
    'x~y',
    '~~~',
    '끝\\~끝',
  ].join('\n');
  assert.equal(escapeReportTildes(input), expected);
});

test('validateReport escapes tildes and accepts an unescaped prior report', () => {
  const report = [
    '# 2026-07-11 뭐 했지',
    '',
    '## 오늘의 요약',
    '',
    '- 값 1~2',
    '',
    '## 작업별 기록',
    '',
    '### T1. 작업',
    '',
    '#### 배경과 목적',
    '',
    '- 범위 3~4',
    '',
    '#### 수행 과정',
    '',
    '- 과정',
    '',
    '#### 결정',
    '',
    '- 결정',
    '',
    '#### 결과',
    '',
    '- 결과 5~6',
    '',
  ].join('\n');
  const validated = validateReport(report, '2026-07-11', 'ko', report, [], { requireTaskFormat: true });
  assert.match(validated, /값 1\\~2/);
  assert.match(validated, /범위 3\\~4/);
  assert.doesNotMatch(validated.replace(/\\~/g, ''), /~/);
});
