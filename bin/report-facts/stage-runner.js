'use strict';

// Stage-aware model calls: per-stage reasoning effort and per-stage call accounting for cost analysis.

// Stages that keep the configured reasoning effort (grouping too: 11-22 grouping F1 fell from 0.80 to 0.66 without thinking).
// The rest are short judgments that may run at a lighter effort.
const HEAVY_STAGES = new Set(['extract', 'write', 'group', 'reassign']);

function effortFor(stage, lightEffort) {
  return HEAVY_STAGES.has(stage) || !lightEffort ? undefined : lightEffort;
}

// forStage(name) returns a runPrompt for that stage; stats() reports calls, summed call time, wall span, and sizes per stage.
function createStageRunner({ runPrompt, lightEffort = '' }) {
  const stages = {};
  const forStage = stage => async prompt => {
    const started = Date.now();
    const effort = effortFor(stage, lightEffort);
    const entry = stages[stage] || (stages[stage] = { calls: 0, callMs: 0, first: started, last: started, promptChars: 0, outputChars: 0 });
    try {
      const output = await runPrompt(prompt, { effort });
      entry.outputChars += String(output || '').length;
      return output;
    } finally {
      entry.calls++;
      entry.callMs += Date.now() - started;
      entry.last = Math.max(entry.last, Date.now());
      entry.promptChars += String(prompt).length;
    }
  };
  const stats = () => Object.fromEntries(Object.entries(stages).map(([name, entry]) => [name, {
    calls: entry.calls,
    callSeconds: Math.round(entry.callMs / 1000),
    wallSeconds: Math.round((entry.last - entry.first) / 1000),
    promptKChars: Math.round(entry.promptChars / 1000),
    outputKChars: Math.round(entry.outputChars / 1000),
  }]));
  return { forStage, stats };
}

module.exports = {
  createStageRunner,
  effortFor,
};
