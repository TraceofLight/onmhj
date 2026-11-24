'use strict';

// Shared vocabulary (fact kinds, statuses, sections) and small helpers used by every stage.

const STATUSES = ['확인', '예상', '권고', '계획', '미확인'];

const KINDS = ['요청', '수행', '안내', '결정', '진단', '결과', '후속', '정정'];

// Report section index per kind (taskSections 0-3, 4 = follow-up); 정정 is applied to other facts, not written as its own bullet.
const SECTION_INDEX = { 요청: 0, 수행: 1, 안내: 1, 결정: 2, 진단: 3, 결과: 3, 후속: 4 };

const KIND_GUIDE = '요청=사용자가 원한 것과 동기, 수행=실제로 실행한 명령·수정·설치, 안내=AI가 사용자에게 안내·권고한 절차나 점검 목록(사용자가 실제로 했는지는 별개), 결정=사용자나 AI가 여러 안 중 고른 방향과 그 이유, 진단=원인 분석·판단·추정 결론, 결과=실행 뒤 관찰된 상태·수치·커밋·확인하지 못한 점, 후속=하루가 끝날 때까지 남은 일, 정정=앞선 내용이나 값을 바로잡은 것';

function sectionOf(contract, kind) {
  const index = SECTION_INDEX[kind];
  if (index === undefined) return null;
  return index === 4 ? contract.followUp : contract.taskSections[index];
}

const EVIDENCE_TURN_CHARS = 4000;

function renderFact(fact) {
  return `${fact.id} | ${fact.time.slice(11, 16)} | ${fact.kind} | ${fact.status}${fact.importance === 'detail' ? ' | 세부' : ''} | ${fact.text}${fact.values.length ? ` | 값: ${fact.values.join(', ')}` : ''}`;
}

module.exports = {
  STATUSES,
  KINDS,
  KIND_GUIDE,
  sectionOf,
  EVIDENCE_TURN_CHARS,
  renderFact,
};
