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

test('Codex continuation completes the unfinished human turn with its original identity', () => {
  const records = [
    { type: 'event_msg', timestamp: '2026-09-03T12:54:00Z', payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'human request' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'continuation' } },
    { type: 'event_msg', payload: { type: 'token_count' } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'answer' } },
  ];
  const { events } = parse(records, parseCodexRecord);
  assert.equal(events.length, 1);
  assert.equal(events[0].turnId, 'original');
  assert.equal(events[0].prompt, 'human request');
  assert.equal(events[0].tsUtc, '2026-09-03T12:54:00Z');
  assert.equal(events[0].assistantResponse, 'answer');
  const fallback = records.slice(0, -1).concat([
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'current answer' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.equal(parse(fallback, parseCodexRecord).events[0].assistantResponse, 'current answer');
  records.splice(3, 0, { type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new request' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'continuation' },
  } });
  const replacement = parse(records, parseCodexRecord).events[0];
  assert.equal(replacement.turnId, 'continuation');
  assert.equal(replacement.prompt, 'new request');
});

test('Codex heartbeat tool envelopes are internal but arbitrary tool output is not', () => {
  const start = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'heartbeat' } };
  const trigger = { type: 'response_item', payload: {
    type: 'function_call_output', namespace: 'codex_app', name: 'automation_update',
    output: '<heartbeat>\n<automation_id>test</automation_id>\n</heartbeat>',
  } };
  const finish = { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'status' } };
  assert.deepEqual(parse([start, trigger, finish], parseCodexRecord).events, []);
  const human = { type: 'event_msg', payload: { type: 'user_message', message: 'human request' } };
  assert.equal(parse([start, human, trigger, finish], parseCodexRecord).events[0].prompt, 'human request');
  trigger.payload.namespace = 'unrelated';
  assert.throws(() => parse([start, trigger, finish], parseCodexRecord), /codex_missing_user_message/);
});

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

test('Codex forked subagent transcripts retain their source across inherited parent metadata', () => {
  const parent = { type: 'session_meta', payload: { id: 'parent', thread_source: 'user' } };
  const start = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } };
  const activity = { type: 'event_msg', payload: { type: 'token_count' } };
  const finish = { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'answer' } };
  for (const source of [{ thread_source: 'subagent' },
    { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }]) {
    const child = { type: 'session_meta', payload: { id: 'child', ...source } };
    assert.deepEqual(parse([child, parent, start, activity, finish], parseCodexRecord).events, []);
    const human = { type: 'event_msg', payload: { type: 'user_message', message: 'preserved human task' } };
    assert.equal(parse([child, parent, start, human, finish], parseCodexRecord).events[0].prompt,
      'preserved human task');
    assert.throws(() => parse([parent, child, start, activity, finish], parseCodexRecord),
      err => err.code === 'codex_missing_user_message');
  }
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

test('Codex parser recovers metadata-linked response users and preserves legacy prompts', () => {
  const start = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } };
  const finish = { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'answer' } };
  const response = content => ({
    type: 'response_item',
    payload: {
      type: 'message', role: 'user', content,
      internal_chat_message_metadata_passthrough: { turn_id: 'turn' },
    },
  });
  for (const [content, expected] of [
    [[{ type: 'input_text', text: 'actual task' }], 'actual task'],
    [[{ type: 'input_text', text: '<environment_context>injected</environment_context>' },
      { type: 'input_image', image_url: 'private image' },
      { type: 'input_text', text: 'describe this' }], 'describe this'],
    [[{ type: 'input_image', image_url: 'private image' }], '[image]'],
  ]) {
    const { events } = parse([start, response(content), finish], parseCodexRecord);
    assert.equal(events.length, 1);
    assert.equal(events[0].prompt, expected);
    assert.equal(events[0].assistantResponse, 'answer');
  }
  const legacy = { type: 'event_msg', payload: { type: 'user_message', message: 'legacy prompt' } };
  for (const middle of [[legacy, response([{ type: 'input_text', text: 'duplicate' }])],
    [response([{ type: 'input_text', text: 'duplicate' }]), legacy]]) {
    assert.equal(parse([start, ...middle, finish], parseCodexRecord).events[0].prompt, 'legacy prompt');
  }
  const mismatched = response([{ type: 'input_text', text: 'unrelated turn' }]);
  mismatched.payload.internal_chat_message_metadata_passthrough.turn_id = 'other';
  assert.throws(() => parse([start, mismatched, finish], parseCodexRecord),
    err => err.code === 'codex_missing_user_message');
  assert.throws(() => parse([start, response([{ type: 'unknown', text: 'private' }]), finish], parseCodexRecord),
    err => err.code === 'codex_invalid_user_message');
});

test('Codex model-switch continuation is internal without discarding a human prompt', () => {
  const start = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } };
  const modelSwitch = {
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [
      { type: 'input_text', text: '<model_switch>continue with the new model</model_switch>' },
    ] },
  };
  const finish = { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'answer' } };
  assert.deepEqual(parse([start, modelSwitch, finish], parseCodexRecord).events, []);
  const human = { type: 'event_msg', payload: { type: 'user_message', message: 'human task' } };
  assert.equal(parse([start, human, modelSwitch, finish], parseCodexRecord).events[0].prompt, 'human task');
  modelSwitch.payload.content[0].text = 'unknown developer instruction';
  assert.throws(() => parse([start, modelSwitch, finish], parseCodexRecord),
    err => err.code === 'codex_missing_user_message');
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
