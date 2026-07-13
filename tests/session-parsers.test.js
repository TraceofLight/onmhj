const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeOpenAIExchange,
  parseClaudeRecord,
  parseCodexRecord,
} = require('../bin/session-parsers');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
}

function parse(records, parseRecord) {
  let state = {};
  const events = [];
  for (const record of records) {
    const result = parseRecord(record, state);
    state = result.state;
    events.push(...result.events);
  }
  return { events, state };
}

test('Codex parser emits one canonical completed turn', () => {
  const { events } = parse(fixture('codex-transcript.jsonl'), parseCodexRecord);

  assert.deepEqual(events, [{
    provider: 'codex',
    sessionId: 'codex-session-1',
    turnId: 'turn-1',
    tsUtc: '2026-07-13T01:00:01.000Z',
    cwd: 'D:\\work\\repo',
    prompt: 'actual user task',
    assistantResponse: 'completed answer',
    status: 'complete',
  }]);
});

test('answerless Codex completion preserves the prompt as pending', () => {
  const { events } = parse([{
    type: 'session_meta',
    payload: { session_id: 'codex-session', cwd: 'D:\\work\\repo' },
  }, {
    type: 'event_msg',
    timestamp: '2026-07-13T01:00:00.000Z',
    payload: { type: 'task_started', turn_id: 'answerless-turn' },
  }, {
    type: 'event_msg',
    payload: { type: 'user_message', message: 'human task without a final answer' },
  }, {
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: '' },
  }], parseCodexRecord);

  assert.deepEqual(events, [{
    provider: 'codex',
    sessionId: 'codex-session',
    turnId: 'answerless-turn',
    tsUtc: '2026-07-13T01:00:00.000Z',
    cwd: 'D:\\work\\repo',
    prompt: 'human task without a final answer',
    status: 'pending',
  }]);
});

test('Codex parser skips a known injected context-only turn', () => {
  const { events, state } = parse([
    {
      type: 'event_msg',
      timestamp: '2026-07-13T01:00:00.000Z',
      payload: { type: 'task_started', turn_id: 'internal-context' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<recommended_plugins>internal</recommended_plugins>' },
          { type: 'input_text', text: '# AGENTS.md instructions\ninternal' },
          { type: 'input_text', text: '<environment_context>internal</environment_context>' },
        ],
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'internal result' },
    },
  ], parseCodexRecord);

  assert.deepEqual(events, []);
  assert.equal(state.turn, undefined);
});

test('Codex parser skips a prompt-less inter-agent turn', () => {
  const { events, state } = parse([
    {
      type: 'event_msg',
      timestamp: '2026-07-13T01:00:00.000Z',
      payload: { type: 'task_started', turn_id: 'inter-agent' },
    },
    { type: 'inter_agent_communication_metadata', payload: {} },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'internal result' },
    },
  ], parseCodexRecord);

  assert.deepEqual(events, []);
  assert.equal(state.turn, undefined);
});

test('Codex parser skips a compaction-only turn', () => {
  const { events, state } = parse([
    {
      type: 'event_msg',
      timestamp: '2026-07-13T01:00:00.000Z',
      payload: { type: 'task_started', turn_id: 'compaction' },
    },
    { type: 'compacted', payload: {} },
    { type: 'event_msg', payload: { type: 'token_count' } },
    { type: 'event_msg', payload: { type: 'context_compacted' } },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'compacted context' },
    },
  ], parseCodexRecord);

  assert.deepEqual(events, []);
  assert.equal(state.turn, undefined);
});

test('Codex parser skips an empty prompt-less no-op turn', () => {
  const { events, state } = parse([
    {
      type: 'event_msg',
      timestamp: '2026-03-15T14:55:17.000Z',
      payload: { type: 'task_started', turn_id: 'empty-no-op' },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: '' },
    },
  ], parseCodexRecord);

  assert.deepEqual(events, []);
  assert.equal(state.turn, undefined);
});

test('Codex parser rejects an unknown prompt-less turn', () => {
  assert.throws(
    () => parse([
      {
        type: 'event_msg',
        timestamp: '2026-07-13T01:00:00.000Z',
        payload: { type: 'task_started', turn_id: 'unknown' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'unknown injected record' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'unknown result' },
      },
    ], parseCodexRecord),
    err => err.code === 'codex_missing_user_message',
  );
});

test('Claude parser ignores tool-result users and emits one human turn', () => {
  const { events } = parse(fixture('claude-transcript.jsonl'), parseClaudeRecord);

  assert.deepEqual(events, [{
    provider: 'claude',
    sessionId: 'claude-session-1',
    turnId: 'user-1',
    tsUtc: '2026-07-13T02:00:00.000Z',
    cwd: 'D:\\work\\repo',
    prompt: 'actual claude task',
    assistantResponse: 'claude final answer',
    status: 'complete',
  }]);
});

test('Claude parser preserves a human turn across known internal user records', () => {
  const internalRecords = [{
    type: 'user',
    isMeta: true,
    sourceToolUseID: 'tool-1',
    sessionId: 'claude-session',
    uuid: 'skill-injection',
    message: { content: [{ type: 'text', text: 'Base directory for this skill: C:\\skill' }] },
  }, {
    type: 'user',
    sessionId: 'claude-session',
    uuid: 'legacy-skill-injection',
    message: { content: 'Base directory for this skill: C:\\legacy-skill' },
  }, {
    type: 'user',
    sessionId: 'claude-session',
    uuid: 'task-notification',
    message: { content: '<task-notification>background task completed</task-notification>' },
  }, {
    type: 'user',
    sessionId: 'claude-session',
    uuid: 'compaction',
    message: { content: 'This session is being continued from a previous conversation that ran out of context. Summary follows.' },
  }, {
    type: 'user',
    sessionId: 'claude-session',
    uuid: 'malformed-tool',
    message: { content: 'Your tool call was malformed and could not be parsed. Retry it.' },
  }, {
    type: 'user',
    sessionId: 'claude-session',
    uuid: 'interrupted',
    message: { content: '[Request interrupted by user]' },
  }];

  for (const internal of internalRecords) {
    const { events } = parse([{
      type: 'user',
      sessionId: 'claude-session',
      uuid: 'human-turn',
      timestamp: '2026-07-13T02:00:00.000Z',
      cwd: 'D:\\work\\repo',
      message: { content: 'actual human task' },
    }, internal, {
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'actual final answer' }],
      },
    }], parseClaudeRecord);

    assert.equal(events.length, 1, internal.uuid);
    assert.equal(events[0].prompt, 'actual human task', internal.uuid);
    assert.equal(events[0].assistantResponse, 'actual final answer', internal.uuid);
  }
});

test('Claude command envelopes clear an unfinished human turn', () => {
  for (const content of [
    '<command-name>/model</command-name><command-message>model</command-message>',
    '<local-command-stdout>changed model</local-command-stdout>',
  ]) {
    const { events, state } = parse([{
      type: 'user',
      sessionId: 'claude-session',
      uuid: 'unfinished-human-turn',
      timestamp: '2026-07-13T02:00:00.000Z',
      message: { content: 'unfinished human task' },
    }, {
      type: 'user',
      sessionId: 'claude-session',
      uuid: 'command-envelope',
      message: { content },
    }, {
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'command response' }],
      },
    }], parseClaudeRecord);

    assert.deepEqual(events, []);
    assert.equal(state.turn, undefined);
  }
});

test('Claude parser rejects an unclassified user content shape', () => {
  for (const content of [
    [{ type: 'protocol', value: 'unknown' }],
    [{ type: 'text', text: 'apparently human text' }, { type: 'protocol', value: 'unknown' }],
  ]) {
    assert.throws(
      () => parseClaudeRecord({
        type: 'user',
        sessionId: 'claude-session',
        uuid: 'unknown-shape',
        message: { content },
      }),
      err => err.code === 'claude_unclassified_user_message',
    );
  }
});

test('relevant malformed shapes fail without content in the error', () => {
  const secret = 'private prompt body';
  assert.throws(
    () => parseCodexRecord({ type: 'event_msg', payload: { type: 'user_message', message: { secret } } }, {}),
    err => err.code === 'codex_invalid_user_message' && !err.message.includes(secret),
  );
  assert.throws(
    () => parseClaudeRecord({ type: 'assistant', message: { content: secret } }, { turn: { prompt: 'x' } }),
    err => err.code === 'claude_invalid_assistant_message' && !err.message.includes(secret),
  );
});

test('OpenAI-compatible parser accepts provider reasoning aliases without retaining them', () => {
  for (const reasoningField of ['reasoning_content', 'reasoning']) {
    const event = normalizeOpenAIExchange({
      provider: reasoningField === 'reasoning' ? 'vllm' : 'glm',
      tsUtc: '2026-07-13T03:00:00.000Z',
      cwd: 'D:\\work\\repo',
      request: { model: 'model', messages: [{ role: 'user', content: 'api task' }] },
      response: {
        id: `response-${reasoningField}`,
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'api answer', [reasoningField]: 'private reasoning' },
        }],
      },
    });

    assert.equal(event.prompt, 'api task');
    assert.equal(event.assistantResponse, 'api answer');
    assert.equal(Object.hasOwn(event, reasoningField), false);
  }
});

test('OpenAI-compatible parser accepts string and object tool arguments', () => {
  for (const args of ['{"value":1}', { value: 1 }]) {
    const event = normalizeOpenAIExchange({
      provider: 'compatible',
      request: { messages: [{ role: 'user', content: 'use tool' }] },
      response: {
        id: typeof args === 'string' ? 'string-args' : 'object-args',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'inspect', arguments: args } }],
          },
        }],
      },
    });
    assert.deepEqual(event.toolNames, ['inspect']);
  }
});

test('OpenAI-compatible parser rejects raw DSML and empty tool-call results', () => {
  const capture = toolCalls => ({
    request: { messages: [{ role: 'user', content: 'use tool' }] },
    response: {
      id: 'bad-tool',
      choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: toolCalls } }],
    },
  });

  assert.throws(
    () => normalizeOpenAIExchange(capture([{ function: { name: 'inspect', arguments: '<｜DSML｜tool_calls>' } }])),
    err => err.code === 'openai_invalid_tool_arguments',
  );
  assert.throws(
    () => normalizeOpenAIExchange(capture([])),
    err => err.code === 'openai_missing_tool_calls',
  );
});
