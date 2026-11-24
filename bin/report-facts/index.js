'use strict';

// Fact-first report pipeline for smaller local models:
// extract typed facts per chunk (chained per session) -> group into tasks -> review -> write cited bullets -> verify -> assemble.

const { mapLimit } = require('../report-util');
const { createStageRunner } = require('./stage-runner');
const { buildTurns } = require('./turns');
const { extractFacts } = require('./extract');
const { groupFacts, reassignFacts } = require('./group');
const { reviewFacts } = require('./review');
const { writeTask, placeByKind } = require('./write');
const { verifyTask, needsPolish, polishTask } = require('./verify');
const { parseTaskMarkdown } = require('./task-markdown');
const { referenceTasks, finalizeTask, writeSummary } = require('./assemble');

// Facts in extraction order inside each task, and tasks in order of their first fact.
function orderTasks(tasks, facts) {
  const order = new Map(facts.map((fact, i) => [fact.id, i]));
  return tasks
    .map(task => ({ ...task, factIds: [...task.factIds].sort((a, b) => order.get(a) - order.get(b)) }))
    .sort((a, b) => order.get(a.factIds[0]) - order.get(b.factIds[0]));
}

// Review -> write -> place -> verify -> (polish) for one task; updates reviewed facts in factsById.
async function processTask({ task, number, otherTitles, contract, factsById, turnsByKey, corrections, stage, counters }) {
  const taskTurns = [...new Set(task.factIds.map(id => factsById.get(id).turn))].map(key => turnsByKey.get(key));
  const review = await reviewFacts({ facts: task.factIds.map(id => factsById.get(id)), turns: taskTurns, runPrompt: stage('review') });
  review.all.forEach(fact => factsById.set(fact.id, fact));
  counters.reviewed += review.changed;
  counters.prunedFacts += review.dropped.length;
  const kept = { ...task, factIds: review.facts.map(fact => fact.id) };
  const first = await writeTask({ contract, number, task: kept, factsById, turnsByKey, corrections, otherTitles, runPrompt: stage('write') });
  const draft = { ...first, ...parseTaskMarkdown(placeByKind(first, contract, factsById), contract, number, kept.factIds) };
  const verified = await verifyTask({ written: draft, contract, number, task: kept, factsById, turnsByKey, corrections, runPrompt: stage('verify') });
  const polished = needsPolish(verified) ? await polishTask({ written: verified, runPrompt: stage('polish') }) : { written: verified, changed: 0 };
  counters.polishedLines += polished.changed;
  return polished.written;
}

function sumRuleStats(written) {
  return written.reduce((all, item) => {
    for (const [rule, stat] of Object.entries(item.ruleStats || {})) {
      all[rule] = all[rule] || { flagged: 0, changed: 0 };
      all[rule].flagged += stat.flagged;
      all[rule].changed += stat.changed;
    }
    return all;
  }, {});
}

function reportStats({ extracted, chunks, tasks, written, reassigned, counters, stageStats, factsById, turnsByKey }) {
  return {
    facts: extracted.facts.length,
    extractCacheHits: extracted.cacheHits,
    chunks: chunks.length,
    resolved: extracted.resolvedIds.size,
    corrections: extracted.corrections.length,
    tasks: tasks.length,
    stages: stageStats,
    reviewedFacts: counters.reviewed,
    prunedFacts: counters.prunedFacts,
    reassignCandidates: reassigned.candidates,
    reassignedFacts: reassigned.moved,
    taskTurns: tasks.map(task => [...new Set(task.factIds.map(id => (turnsByKey.get(factsById.get(id).turn) || {}).id))]),
    polishedLines: counters.polishedLines,
    uncited: written.reduce((sum, item) => sum + item.uncited.length, 0),
    fallbackTasks: written.filter(item => item.fallback).length,
    flags: written.reduce((sum, item) => sum + item.flags, 0),
    fixes: written.reduce((sum, item) => sum + (item.applied || 0), 0),
    remainingFlags: written.reduce((sum, item) => sum + item.remaining, 0),
    rules: sumRuleStats(written),
  };
}

async function generateFactReport({ date, records, chunks, contract, title, runPrompt, renderReference, concurrency = 3, log = () => {}, chunkCache = null, lightEffort = '' }) {
  const turns = buildTurns(records);
  const turnsById = new Map(turns.map(turn => [turn.id, turn]));
  const turnsByKey = new Map(turns.map(turn => [turn.key, turn]));
  const runner = createStageRunner({ runPrompt, lightEffort });
  const stage = runner.forStage;
  const extracted = await extractFacts({ chunks, turnsById, runPrompt: stage('extract'), concurrency, chunkCache });
  const facts = extracted.facts.filter(fact => !extracted.resolvedIds.has(fact.id));
  const factsById = new Map(facts.map(fact => [fact.id, fact]));
  const grouped = await groupFacts({ facts, turnsByKey, runPrompt: stage('group') });
  const reassigned = await reassignFacts({ tasks: grouped, factsById, runPrompt: stage('reassign') });
  const tasks = orderTasks(reassigned.tasks, facts);
  const titles = tasks.map((task, i) => `T${i + 1}. ${task.title}`);
  const counters = { reviewed: 0, prunedFacts: 0, polishedLines: 0 };
  const written = await mapLimit(tasks, concurrency, (task, i) => processTask({
    task,
    number: i + 1,
    otherTitles: titles.filter((_, k) => k !== i),
    contract,
    factsById,
    turnsByKey,
    corrections: extracted.corrections,
    stage,
    counters,
  }));
  const referenceOwners = referenceTasks(tasks, factsById, turnsByKey);
  const bodies = written.map((item, i) => {
    const references = (referenceOwners.get(i) || []);
    return finalizeTask(item, contract, references.map(reference => `- ${renderReference(reference)}`));
  });
  const summary = await writeSummary({ written, factsById, runPrompt: stage('summary') });
  log(reportStats({ extracted, chunks, tasks, written, reassigned, counters, stageStats: runner.stats(), factsById, turnsByKey }));
  return `# ${date} ${title}\n\n## ${contract.summary}\n\n${summary}\n\n## ${contract.tasks}\n\n${bodies.join('\n\n')}\n`;
}

// Extraction only, for ahead-of-time caching; grouping and writing happen when the report is generated.
async function prefetchExtraction({ records, chunks, runPrompt, chunkCache, concurrency = 3 }) {
  const turns = buildTurns(records);
  const result = await extractFacts({ chunks, turnsById: new Map(turns.map(turn => [turn.id, turn])), runPrompt, concurrency, chunkCache });
  return { facts: result.facts.length, cacheHits: result.cacheHits };
}

module.exports = {
  generateFactReport,
  prefetchExtraction,
};
