const assert = require('node:assert/strict');
const test = require('node:test');
const { completeReportReferences, extractExternalReferences, validateReport } = require('../bin/onmhj.js');

const urls = [
  "https://example.com/a'b",
  'https://example.com/a(b)c',
  'https://example.com/a(b(c))',
  'https://example.com/10.1000/xyz',
  'https://doi.org/10.1000/xyz',
];

test('extracts Markdown, autolink and bare URLs once without truncating valid paths', () => {
  for (const url of urls) {
    for (const text of [`[자료](${url})`, `<${url}>`, `${url}.`, `(${url})`, `'${url}'`]) {
      assert.deepEqual(extractExternalReferences(text).map(reference => reference.url), [url], text);
    }
  }
  assert.deepEqual(extractExternalReferences('[자료](https://example.com/a(b)c)뒤의 설명'), [
    { title: '자료', url: 'https://example.com/a(b)c' },
  ]);
});

test('preserves explicit URL punctuation and supports a separate bare DOI', () => {
  assert.deepEqual(extractExternalReferences('[자료](https://example.com/why!) <https://example.com/end.>'), [
    { title: '자료', url: 'https://example.com/why!' },
    { title: '', url: 'https://example.com/end.' },
  ]);
  assert.deepEqual(extractExternalReferences('https://example.com/10.1000/xyz DOI: 10.2000/a(b).'), [
    { title: '', url: 'https://example.com/10.1000/xyz' },
    { title: '', url: 'https://doi.org/10.2000/a(b)' },
  ]);
});

test('continues filtering private and secret URLs without extracting their DOI paths', () => {
  const text = [
    '[내부](http://localhost/10.1000/xyz)',
    'http://192.168.0.2/10.1000/xyz',
    '<https://notes.internal/10.1000/xyz>',
    'https://user:password@example.com/10.1000/xyz',
    '[비밀](https://example.com/10.1000/xyz?token=secret)',
  ].join('\n');
  assert.deepEqual(extractExternalReferences(text), []);
});

test('completed references survive report validation and repeated completion unchanged', () => {
  const date = '2026-09-07';
  const report = `# ${date} 뭐 했지

## 오늘의 요약
- 링크 추출 수정

## 작업별 기록

### T1. 링크 추출

#### 배경과 목적
- 원본 보존

#### 수행 과정
- 추출 검증

#### 결정
- 중복 제거

#### 결과
- 검증 완료
`;
  const references = [...urls, 'https://example.com/end.', 'https://example.com/why!']
    .map(url => ({ title: '', url }));
  const completed = completeReportReferences(report, references);
  assert.deepEqual(extractExternalReferences(completed).map(reference => reference.url), references.map(reference => reference.url));
  assert.equal(completeReportReferences(completed, references), completed);
  assert.equal(validateReport(completed, date, 'ko', '', references, { requireTaskFormat: true }), `${completed.trim()}\n`);
});
