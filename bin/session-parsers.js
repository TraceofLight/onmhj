class SessionParserError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parserError(code) {
  throw new SessionParserError(code);
}

const CODEX_INTERNAL_CONTEXT_PREFIXES = [
  '<recommended_plugins',
  '<codex_internal_context',
  '# AGENTS.md instructions',
  '<environment_context>',
];

function codexContextOnlyUser(payload) {
  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return false;
  if (!payload.content.length) return false;
  return payload.content.every(block => {
    if (!block || block.type !== 'input_text' || typeof block.text !== 'string') return false;
    const text = block.text.trimStart();
    return CODEX_INTERNAL_CONTEXT_PREFIXES.some(prefix => text.startsWith(prefix));
  });
}

function parseCodexRecord(record, previous = {}) {
  const state = { ...previous };
  const payload = record && record.payload;
  if (!record || typeof record !== 'object' || !payload || typeof payload !== 'object') {
    return { state, events: [] };
  }

  if (record.type === 'session_meta') {
    state.sessionId = String(payload.session_id || payload.id || state.sessionId || '');
    state.cwd = String(payload.cwd || state.cwd || '');
    return { state, events: [] };
  }

  if (record.type === 'inter_agent_communication_metadata' ||
      (record.type === 'response_item' && codexContextOnlyUser(payload))) {
    if (state.turn) state.turn = { ...state.turn, internal: true };
    return { state, events: [] };
  }

  if (record.type !== 'event_msg') return { state, events: [] };
  if (payload.type === 'task_started') {
    if (typeof payload.turn_id !== 'string') parserError('codex_invalid_task_started');
    state.turn = {
      sessionId: state.sessionId || '',
      turnId: payload.turn_id,
      tsUtc: String(record.timestamp || ''),
      cwd: state.cwd || '',
      prompt: '',
      assistantResponse: '',
    };
    return { state, events: [] };
  }

  if (payload.type === 'user_message') {
    if (typeof payload.message !== 'string') parserError('codex_invalid_user_message');
    state.turn = state.turn || {
      sessionId: state.sessionId || '',
      turnId: String(payload.client_id || record.timestamp || ''),
      tsUtc: String(record.timestamp || ''),
      cwd: state.cwd || '',
      assistantResponse: '',
    };
    state.turn.prompt = payload.message;
    return { state, events: [] };
  }

  if (payload.type === 'agent_message' && payload.phase === 'final_answer') {
    if (typeof payload.message !== 'string') parserError('codex_invalid_agent_message');
    if (state.turn) state.turn.assistantResponse = payload.message;
    return { state, events: [] };
  }

  if (payload.type !== 'task_complete' || !state.turn) return { state, events: [] };
  const turn = state.turn;
  const assistantResponse = typeof payload.last_agent_message === 'string'
    ? payload.last_agent_message
    : turn.assistantResponse;
  if (typeof turn.prompt !== 'string' || !turn.prompt) {
    if (turn.internal) {
      delete state.turn;
      return { state, events: [] };
    }
    parserError('codex_missing_user_message');
  }
  if (typeof assistantResponse !== 'string') parserError('codex_invalid_task_complete');
  delete state.turn;
  return {
    state,
    events: [{
      provider: 'codex',
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      tsUtc: turn.tsUtc,
      cwd: turn.cwd,
      prompt: turn.prompt,
      assistantResponse,
      status: 'complete',
    }],
  };
}

function humanClaudePrompt(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some(block => block && block.type === 'tool_result')) return null;
  const text = content
    .filter(block => block && block.type === 'text')
    .map(block => typeof block.text === 'string' ? block.text : parserError('claude_invalid_user_message'))
    .join('\n');
  if (text) return text;
  if (content.some(block => block && block.type === 'image')) return '[image]';
  return undefined;
}

function parseClaudeRecord(record, previous = {}) {
  const state = { ...previous };
  if (!record || typeof record !== 'object') return { state, events: [] };

  if (record.type === 'user') {
    const message = record.message;
    const prompt = humanClaudePrompt(message && message.content);
    if (prompt === null) return { state, events: [] };
    if (typeof prompt !== 'string') parserError('claude_invalid_user_message');
    if (typeof record.uuid !== 'string') parserError('claude_missing_user_uuid');
    state.turn = {
      sessionId: String(record.sessionId || ''),
      turnId: record.uuid,
      tsUtc: String(record.timestamp || ''),
      cwd: String(record.cwd || ''),
      prompt,
    };
    return { state, events: [] };
  }

  if (record.type !== 'assistant') return { state, events: [] };
  const message = record.message;
  if (!message || !Array.isArray(message.content)) parserError('claude_invalid_assistant_message');
  if (!state.turn || message.stop_reason !== 'end_turn') return { state, events: [] };
  const text = message.content
    .filter(block => block && block.type === 'text')
    .map(block => typeof block.text === 'string' ? block.text : parserError('claude_invalid_assistant_message'))
    .join('\n');
  if (!text) return { state, events: [] };
  const turn = state.turn;
  delete state.turn;
  return {
    state,
    events: [{
      provider: 'claude',
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      tsUtc: turn.tsUtc,
      cwd: turn.cwd,
      prompt: turn.prompt,
      assistantResponse: text,
      status: 'complete',
    }],
  };
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && ['text', 'input_text'].includes(item.type))
    .map(item => String(item.text || ''))
    .filter(Boolean)
    .join('\n');
}

function normalizeToolCalls(choice) {
  const calls = choice.message.tool_calls;
  if (choice.finish_reason === 'tool_calls' && (!Array.isArray(calls) || !calls.length)) {
    parserError('openai_missing_tool_calls');
  }
  if (!Array.isArray(calls)) return [];
  return calls.map(call => {
    const fn = call && call.function;
    if (!fn || typeof fn.name !== 'string') parserError('openai_invalid_tool_call');
    const args = fn.arguments;
    if (typeof args === 'string') {
      if (args.includes('DSML')) parserError('openai_invalid_tool_arguments');
      try {
        JSON.parse(args);
      } catch {
        parserError('openai_invalid_tool_arguments');
      }
    } else if (!args || typeof args !== 'object' || Array.isArray(args)) {
      parserError('openai_invalid_tool_arguments');
    }
    return fn.name;
  });
}

function normalizeOpenAIExchange(capture) {
  const request = capture && capture.request;
  const response = capture && capture.response;
  const messages = request && request.messages;
  const choice = response && response.choices && response.choices[0];
  if (!Array.isArray(messages) || !choice || !choice.message) parserError('openai_invalid_capture');
  const user = [...messages].reverse().find(message => message && message.role === 'user');
  const prompt = messageText(user && user.content);
  if (!prompt) parserError('openai_missing_user_message');
  const assistantResponse = choice.message.content == null ? '' : choice.message.content;
  if (typeof assistantResponse !== 'string') parserError('openai_invalid_assistant_message');
  const id = response.request_id || response.id || capture.requestId;
  if (!id) parserError('openai_missing_response_id');
  return {
    provider: String(capture.provider || 'openai-compatible'),
    model: String(response.model || request.model || ''),
    sessionId: String(capture.sessionId || id),
    turnId: String(id),
    tsUtc: String(capture.tsUtc || ''),
    cwd: String(capture.cwd || ''),
    prompt,
    assistantResponse,
    toolNames: normalizeToolCalls(choice),
    status: choice.finish_reason === 'tool_calls' ? 'tool_call' : 'complete',
  };
}

module.exports = {
  SessionParserError,
  normalizeOpenAIExchange,
  parseClaudeRecord,
  parseCodexRecord,
};
