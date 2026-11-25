const { escapeReportTildes } = require('../report-markdown');
const { extractExternalReferences, mergeReferences } = require('./references');
const { referenceMarkdown, reportContract } = require('./report-contract');

function validateOrderedSections(value, sections, level, label) {
  let previous = -1;
  for (const section of sections) {
    const marker = `\n${'#'.repeat(level)} ${section}\n`;
    const count = value.split(marker).length - 1;
    if (!count) throw new Error(`report missing section: ${section}`);
    if (count > 1) throw new Error(`report duplicate section: ${section}`);
    const index = value.indexOf(marker);
    if (index < previous) throw new Error(`report section order is invalid: ${section}`);
    previous = index;
  }
  return previous;
}

function validateLegacyReport(report, contract, references) {
  const previous = validateOrderedSections(report, contract.legacySections, 2, 'legacy');
  const allowedReferences = mergeReferences(references);
  if (allowedReferences.length) {
    const marker = `\n## ${contract.references}\n`;
    const count = report.split(marker).length - 1;
    if (!count) throw new Error('report reference section is missing');
    if (count > 1 || report.indexOf(marker) < previous) throw new Error('report reference section is invalid');
    const section = report.slice(report.indexOf(marker) + marker.length);
    const actual = extractExternalReferences(section);
    const allowed = new Set(allowedReferences.map(reference => reference.url));
    if (actual.some(reference => !allowed.has(reference.url))) throw new Error('report contains unsupported reference');
    if (allowedReferences.some(reference => !actual.some(item => item.url === reference.url))) {
      throw new Error('report reference section is incomplete');
    }
  } else if (report.includes(`\n## ${contract.references}\n`)) {
    throw new Error('report contains unsupported reference section');
  }
}

function validateTaskReport(report, contract, references) {
  validateOrderedSections(report, [contract.summary, contract.tasks], 2, 'task');
  const topSections = [...report.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  if (topSections.join('\n') !== [contract.summary, contract.tasks].join('\n')) {
    throw new Error('report top-level sections are invalid');
  }
  const tasks = [...report.matchAll(/^### T(\d+)\. .+$/gm)];
  const thirdLevel = [...report.matchAll(/^### .+$/gm)];
  if (!tasks.length || tasks.length !== thirdLevel.length) throw new Error('report task headings are invalid');
  for (let index = 0; index < tasks.length; index += 1) {
    if (Number(tasks[index][1]) !== index + 1) throw new Error('report task numbering is invalid');
    const start = tasks[index].index;
    const end = tasks[index + 1] ? tasks[index + 1].index : report.length;
    const task = report.slice(start, end);
    validateOrderedSections(task, contract.taskSections, 4, 'task');
    const headings = [...task.matchAll(/^#### (.+)$/gm)].map(match => match[1]);
    const allowed = [...contract.taskSections, contract.followUp, contract.references];
    if (headings.some(section => !allowed.includes(section)) || new Set(headings).size !== headings.length) {
      throw new Error('report task sections are invalid');
    }
    const order = headings.map(section => allowed.indexOf(section));
    if (order.some((value, item) => item && value < order[item - 1])) {
      throw new Error('report task section order is invalid');
    }
  }
  const allowedReferences = mergeReferences(references);
  const actual = extractExternalReferences(report);
  const allowedUrls = new Set(allowedReferences.map(reference => reference.url));
  if (!allowedReferences.length && report.includes(`#### ${contract.references}`)) {
    throw new Error('report contains unsupported reference section');
  }
  if (actual.some(reference => !allowedUrls.has(reference.url))) throw new Error('report contains unsupported reference');
  if (allowedReferences.some(reference => !actual.some(item => item.url === reference.url))) {
    throw new Error('report reference section is incomplete');
  }
  let inTaskReferences = false;
  for (const line of report.split('\n')) {
    if (/^#{1,3}\s/.test(line)) inTaskReferences = false;
    if (line === `#### ${contract.references}`) inTaskReferences = true;
    else if (/^####\s/.test(line)) inTaskReferences = false;
    if (extractExternalReferences(line).length && !inTaskReferences) {
      throw new Error('report reference must be inside a task reference section');
    }
  }
}

function completeReportReferences(report, references, language = 'ko') {
  const allowedReferences = mergeReferences(references);
  const missing = allowedReferences.filter(reference => {
    return !extractExternalReferences(report).some(item => item.url === reference.url);
  });
  if (!missing.length) return report;

  const taskMatches = [...String(report).matchAll(/^### T\d+\. .+$/gm)];
  if (!taskMatches.length) return report;

  const contract = reportContract(language);
  const taskStart = taskMatches.at(-1).index;
  const nextTopSection = String(report).slice(taskStart).search(/\n## /);
  const taskEnd = nextTopSection === -1 ? String(report).length : taskStart + nextTopSection;
  const task = String(report).slice(taskStart, taskEnd).replace(/\s+$/, '');
  const marker = `#### ${contract.references}`;
  const lines = missing.map(reference => `- ${referenceMarkdown(reference)}`);
  const markerIndex = task.indexOf(`\n${marker}\n`);
  const repairedTask = markerIndex === -1
    ? `${task}\n\n${marker}\n\n${lines.join('\n')}`
    : `${task}\n${lines.join('\n')}`;
  return `${String(report).slice(0, taskStart)}${repairedTask}${String(report).slice(taskEnd)}`;
}

function validateReport(value, date, language = 'ko', previousReport = '', references = [], options = {}) {
  const contract = reportContract(language);
  const report = String(value || '').trim() + '\n';
  if (!report.startsWith(`# ${date} ${contract.title}\n`)) {
    throw new Error(`report heading must match work date ${date}`);
  }
  const taskFormat = report.includes(`\n## ${contract.tasks}\n`);
  if (options.requireTaskFormat && !taskFormat) throw new Error('report must use task format');
  if (taskFormat) validateTaskReport(report, contract, references);
  else validateLegacyReport(report, contract, references);
  const escaped = escapeReportTildes(report);
  const remaining = new Map();
  for (const line of escaped.replace(/\r\n/g, '\n').split('\n')) remaining.set(line, (remaining.get(line) || 0) + 1);
  const priorLines = escapeReportTildes(String(previousReport).replace(/\r\n/g, '\n')).split('\n');
  for (const line of priorLines.filter(line => line && !/^#{1,6}\s/.test(line))) {
    const count = remaining.get(line) || 0;
    if (!count) throw new Error('report must preserve prior report content');
    remaining.set(line, count - 1);
  }
  return escaped;
}

module.exports = {
  completeReportReferences,
  validateReport,
};
