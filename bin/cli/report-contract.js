const { extractExternalReferences, mergeReferences } = require('./references');

const REPORT_CONTRACTS = {
  en: {
    title: "Yesterday's work",
    legacySections: ['Summary', 'Work reasons', 'Work process', 'Decisions', 'Results', 'Remaining work'],
    summary: "Today's summary",
    tasks: 'Task records',
    taskSections: ['Background and purpose', 'Work process', 'Decisions', 'Results'],
    followUp: 'Follow-up work',
    references: 'References',
  },
  ko: {
    title: '뭐 했지',
    legacySections: ['요약', '작업 이유', '작업 과정', '결정 사항', '도출 결과', '남은 일'],
    summary: '오늘의 요약',
    tasks: '작업별 기록',
    taskSections: ['배경과 목적', '수행 과정', '결정', '결과'],
    followUp: '후속 작업',
    references: '참고 자료',
  },
};

function reportContract(language = 'ko') {
  return REPORT_CONTRACTS[language] || REPORT_CONTRACTS.ko;
}

function rawReferences(raw) {
  const references = [];
  for (const line of String(raw || '').split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (Array.isArray(event.references)) references.push(...event.references);
    } catch {}
  }
  return mergeReferences(references);
}

function rawReferenceEvidence(raw) {
  const evidence = [];
  for (const line of String(raw || '').split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const references = mergeReferences(event.references || []);
      if (!references.length) continue;
      evidence.push({
        sourceId: event.sourceId || '',
        cwd: event.cwd || '',
        prompt: event.prompt || '',
        references,
      });
    } catch {}
  }
  return evidence;
}

function reportReferenceCatalog(references) {
  return references.map((reference, index) => ({ id: `R${index + 1}`, ...reference }));
}

function referenceMarkdown(reference) {
  const title = String(reference.title || reference.url).replace(/[\r\n]+/g, ' ').replace(/]/g, '\\]');
  return `[${title}](${reference.url})`;
}

function renderReportReferenceIds(report, references, previousReport) {
  const priorUrls = new Set(extractExternalReferences(previousReport).map(reference => reference.url));
  if (extractExternalReferences(report).some(reference => !priorUrls.has(reference.url))) {
    throw new Error('report must use reference IDs for new links');
  }
  const catalog = new Map(reportReferenceCatalog(references).map(reference => [reference.id, reference]));
  const rendered = report.replace(/\{\{ref:([^{}]*)\}\}/g, (_match, id) => {
    const reference = catalog.get(id);
    if (!reference) throw new Error('report contains unknown reference ID');
    return referenceMarkdown(reference);
  });
  if (rendered.includes('{{ref:')) throw new Error('report contains malformed reference ID');
  return rendered;
}

module.exports = {
  rawReferenceEvidence,
  rawReferences,
  referenceMarkdown,
  renderReportReferenceIds,
  reportContract,
  reportReferenceCatalog,
};
