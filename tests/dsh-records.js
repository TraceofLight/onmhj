// Builders for DSH session.v4 records, trimmed to the fields the parser reads.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BASE = Date.parse('2026-07-13T01:00:00Z');

function at(seconds) {
  return BASE + seconds * 1000;
}

function session(id, extra = {}) {
  return { type: 'session', version: 4, id, createdAt: at(0), cwd: '/work/repo', isSeeded: false, delegationDepth: 0, ...extra };
}

function userMessage(seconds, id, text, kind = 'user') {
  return {
    type: 'user/message',
    time: at(seconds),
    data: { content: [{ type: 'text', text }], source: { kind }, role: 'user', id },
  };
}

function assistantMessage(seconds, content) {
  return { type: 'assistant/message', time: at(seconds), data: { message: { role: 'assistant', content } } };
}

function turn(number, seconds, body, reason = 'completed') {
  return [
    { type: 'turn/start', time: at(seconds), data: { turn: number } },
    ...body,
    { type: 'turn/end', time: at(seconds + 30), data: { turn: number, reason: { kind: reason } } },
  ];
}

// One human turn: injected context, a tool step with commentary, then the final answer.
function humanTurn(number, seconds, id, prompt, answer) {
  return turn(number, seconds, [
    userMessage(seconds, id, prompt),
    userMessage(seconds, `${id}-context`, '<system-reminder>context</system-reminder>', 'agent-instructions'),
    assistantMessage(seconds + 1, [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'checking first' },
      { type: 'tool-call', id: 'call', name: 'bash', arguments: '{}' },
    ]),
    assistantMessage(seconds + 2, [{ type: 'text', text: answer }]),
  ]);
}

// DSH appends one zstd frame per write, so a live session file is a growing sequence of frames.
function appendFrames(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const record of records) {
    fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n')));
  }
}

// Points every discovered session root at an empty temporary home so tests never read real transcripts.
function withSessionHomes(root, fn) {
  const keys = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'DSH_HOME'];
  const previous = keys.map(key => process.env[key]);
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = process.env.HOME; // os.homedir() reads USERPROFILE on Windows
  process.env.CODEX_HOME = path.join(root, 'codex');
  process.env.DSH_HOME = path.join(root, 'dsh');
  return Promise.resolve().then(fn).finally(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
}

module.exports = { appendFrames, assistantMessage, at, humanTurn, session, turn, userMessage, withSessionHomes };
