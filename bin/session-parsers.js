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

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&amp;': '&' };

function codexDelegationInput(payload) {
  if (payload.type !== 'function_call_output' || payload.namespace !== 'codex_app' ||
      payload.name !== 'send_message_to_thread' || typeof payload.output !== 'string' ||
      !payload.output.trimStart().startsWith('<codex_delegation>')) return undefined;
  const match = payload.output.match(/<input>([\s\S]*?)<\/input>/);
  if (!match) parserError('codex_invalid_delegation');
  return match[1].replace(/&(?:lt|gt|quot|apos|#39|amp);/g, entity => XML_ENTITIES[entity]).trim();
}

// Codex CLI before 0.142.3 wrote the human prompt only as a metadata-less user message.
const CODEX_LEGACY_BEFORE = [0, 142, 3];
const CODEX_LEGACY_IGNORED_PREFIXES = [...CODEX_INTERNAL_CONTEXT_PREFIXES, '<turn_aborted>', '<image', '</image>'];

function codexLegacyVersion(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  const index = parts.findIndex((part, i) => part !== CODEX_LEGACY_BEFORE[i]);
  return index >= 0 && parts[index] < CODEX_LEGACY_BEFORE[index];
}

function codexUserPrompt(content, ignoredPrefixes) {
  const text = content
    .filter(block => block.type === 'input_text' && !ignoredPrefixes.some(prefix => block.text.trimStart().startsWith(prefix)))
    .map(block => block.text)
    .join('\n');
  return text || (content.some(block => block.type === 'input_image') ? '[image]' : '');
}

function parseCodexRecord(record, previous = {}) {
  const state = { ...previous };
  const payload = record && record.payload;
  if (!record || typeof record !== 'object' || !payload || typeof payload !== 'object') {
    return { state, events: [] };
  }

  if (record.type === 'session_meta') {
    if (state.subagentTranscript === undefined) {
      state.subagentTranscript = payload.thread_source === 'subagent' ||
        !!(payload.source && payload.source.subagent && payload.source.subagent.thread_spawn);
    }
    if (state.legacyUserItems === undefined) state.legacyUserItems = codexLegacyVersion(payload.cli_version);
    state.sessionId = String(payload.session_id || payload.id || state.sessionId || '');
    state.cwd = String(payload.cwd || state.cwd || '');
    return { state, events: [] };
  }

  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (record.type === 'response_item' && state.turn && !state.subagentTranscript && !state.turn.prompt &&
      metadata && metadata.turn_id === state.turn.turnId) {
    const delegated = codexDelegationInput(payload);
    if (delegated) state.turn = { ...state.turn, prompt: delegated };
  }

  if (record.type === 'response_item' && payload.type === 'message' && state.turn) {
    const linked = metadata && metadata.turn_id === state.turn.turnId;
    if (payload.role === 'user' && (linked || (!metadata && state.legacyUserItems))) {
      if (!Array.isArray(payload.content) || !payload.content.every(block => block &&
          ((block.type === 'input_text' && typeof block.text === 'string') || block.type === 'input_image'))) {
        parserError('codex_invalid_user_message');
      }
      const prompt = codexUserPrompt(payload.content, linked ? CODEX_INTERNAL_CONTEXT_PREFIXES : CODEX_LEGACY_IGNORED_PREFIXES);
      // A metadata-linked prompt stays authoritative over one taken from a legacy item.
      if (prompt && (!state.turn.prompt || (linked && state.turn.legacyPrompt))) {
        state.turn = { ...state.turn, prompt, legacyPrompt: !linked };
      }
    }
    if (payload.role === 'developer' && Array.isArray(payload.content) && payload.content.some(
      block => block.type === 'input_text' && typeof block.text === 'string' &&
        block.text.trimStart().startsWith('<model_switch>'))) {
      state.turn = { ...state.turn, internal: true };
    }
  }

  if (record.type === 'inter_agent_communication_metadata' ||
      (record.type === 'response_item' && payload.type === 'function_call_output' &&
        payload.namespace === 'codex_app' && payload.name === 'automation_update' &&
        typeof payload.output === 'string' && payload.output.trimStart().startsWith('<heartbeat>')) ||
      record.type === 'compacted' ||
      (record.type === 'event_msg' && payload.type === 'context_compacted') ||
      (record.type === 'response_item' && codexContextOnlyUser(payload))) {
    if (state.turn) state.turn = { ...state.turn, internal: true };
    return { state, events: [] };
  }

  const taskBoundary = record.type === 'event_msg' &&
    ['task_started', 'task_complete'].includes(payload.type);
  if (state.turn && !taskBoundary) state.turn = { ...state.turn, sawIntermediate: true };

  if (record.type !== 'event_msg') return { state, events: [] };
  if (payload.type === 'task_started') {
    if (typeof payload.turn_id !== 'string') parserError('codex_invalid_task_started');
    const continuation = (state.turn?.prompt ? state.turn : state.turn?.continuation) || state.retryTurn;
    delete state.retryTurn;
    state.turn = {
      sessionId: state.sessionId || '',
      turnId: payload.turn_id,
      tsUtc: String(record.timestamp || ''),
      cwd: state.cwd || '',
      prompt: '',
      assistantResponse: '',
      ...(continuation ? { continuation } : {}),
    };
    return { state, events: [] };
  }

  if (payload.type === 'user_message') {
    if (typeof payload.message !== 'string') parserError('codex_invalid_user_message');
    delete state.retryTurn;
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
  const turn = !state.turn.prompt && !state.turn.internal && state.turn.continuation
    ? state.turn.continuation : state.turn;
  const assistantResponse = typeof payload.last_agent_message === 'string'
    ? payload.last_agent_message
    : state.turn.assistantResponse || (turn.emitted ? turn.assistantResponse : '');
  // An errored completion is retried by the client as a prompt-less turn; link it back to the human turn.
  const retryTurn = payload.error && (turn.prompt ? { ...turn, assistantResponse, emitted: true } : state.turn.continuation);
  if (typeof turn.prompt !== 'string' || !turn.prompt) {
    if (turn.internal || state.subagentTranscript || !turn.sawIntermediate) {
      delete state.turn;
      if (retryTurn) state.retryTurn = retryTurn;
      return { state, events: [] };
    }
    parserError('codex_missing_user_message');
  }
  if (typeof assistantResponse !== 'string') parserError('codex_invalid_task_complete');
  delete state.turn;
  if (retryTurn) state.retryTurn = retryTurn;
  const event = {
    provider: 'codex',
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    tsUtc: turn.tsUtc,
    cwd: turn.cwd,
    prompt: turn.prompt,
    status: assistantResponse ? 'complete' : 'pending',
  };
  if (assistantResponse) event.assistantResponse = assistantResponse;
  return {
    state,
    events: [event],
  };
}

function humanClaudePrompt(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some(block => block && block.type === 'tool_result')) return null;
  if (!content.every(block => block && ['text', 'image'].includes(block.type))) return undefined;
  const text = content
    .filter(block => block && block.type === 'text')
    .map(block => typeof block.text === 'string' ? block.text : parserError('claude_invalid_user_message'))
    .join('\n');
  if (text) return text;
  if (content.some(block => block && block.type === 'image')) return '[image]';
  return undefined;
}

const CLAUDE_INTERNAL_PROMPT_PREFIXES = [
  '<task-notification>',
  'Base directory for this skill:',
  'This session is being continued from a previous conversation that ran out of context.',
  'Your tool call was malformed and could not be parsed.',
];

function claudeUserKind(record, prompt) {
  if (prompt === null || record.isMeta === true || record.sourceToolUseID) return 'internal';
  if (typeof prompt !== 'string') parserError('claude_unclassified_user_message');
  const text = prompt.trimStart();
  if (text.startsWith('<command-name>') || text.startsWith('<local-command')) return 'boundary';
  if (text === '[Request interrupted by user]') return 'internal';
  if (CLAUDE_INTERNAL_PROMPT_PREFIXES.some(prefix => text.startsWith(prefix))) return 'internal';
  return 'human';
}

function parseClaudeRecord(record, previous = {}) {
  const state = { ...previous };
  if (!record || typeof record !== 'object') return { state, events: [] };
  if (typeof record.sessionId === 'string') state.sessionId = record.sessionId;

  if (record.type === 'user') {
    const message = record.message;
    const prompt = humanClaudePrompt(message && message.content);
    const kind = claudeUserKind(record, prompt);
    if (kind === 'internal') return { state, events: [] };
    if (kind === 'boundary') {
      delete state.turn;
      return { state, events: [] };
    }
    if (typeof record.uuid !== 'string') parserError('claude_missing_user_uuid');
    state.turn = {
      sessionId: state.sessionId || '',
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

function dshText(content, code) {
  if (!Array.isArray(content)) parserError(code);
  return content
    .filter(block => block && block.type === 'text')
    .map(block => typeof block.text === 'string' ? block.text : parserError(code))
    .join('\n');
}

function dshPrompt(content) {
  const text = dshText(content, 'dsh_invalid_user_message');
  return text || (content.some(block => block && block.type === 'image') ? '[image]' : '');
}

function dshTimestamp(record) {
  if (!Number.isFinite(record.time)) parserError('dsh_invalid_timestamp');
  return new Date(record.time).toISOString();
}

function dshTurnEvent(turn) {
  const event = {
    provider: 'dsh',
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    tsUtc: turn.tsUtc,
    cwd: turn.cwd,
    prompt: turn.prompt,
    status: turn.assistantResponse ? 'complete' : 'pending',
  };
  if (turn.assistantResponse) event.assistantResponse = turn.assistantResponse;
  return event;
}

function startDshTurn(state, record) {
  // A forked session first replays its parent's records with their original, earlier times.
  if (state.seededBefore && record.time < state.seededBefore) {
    delete state.turn;
    return;
  }
  state.turn = {
    sessionId: state.sessionId || '',
    turnId: '',
    tsUtc: dshTimestamp(record),
    cwd: state.cwd || '',
    prompt: '',
    assistantResponse: '',
  };
}

function addDshPrompt(state, record) {
  const prompt = dshPrompt(record.data.content);
  if (!prompt) return;
  const turn = { ...state.turn };
  if (!turn.prompt) {
    if (typeof record.data.id !== 'string' || !record.data.id) parserError('dsh_missing_user_message_id');
    turn.turnId = record.data.id;
    turn.tsUtc = dshTimestamp(record);
  }
  // A message sent while the agent works is spliced into the running turn.
  turn.prompt = turn.prompt ? `${turn.prompt}\n\n${prompt}` : prompt;
  state.turn = turn;
}

function endDshTurn(state) {
  const turn = state.turn;
  delete state.turn;
  if (turn.prompt) {
    state.last = dshTurnEvent(turn);
    return [state.last];
  }
  // A prompt-less turn resumes the last human turn, for example after subagent results arrive.
  if (!state.last || !turn.assistantResponse) return [];
  state.last = {
    ...state.last,
    assistantResponse: [state.last.assistantResponse, turn.assistantResponse].filter(Boolean).join('\n\n'),
    status: 'complete',
  };
  return [state.last];
}

function parseDshRecord(record, previous = {}) {
  const state = { ...previous };
  if (!record || typeof record !== 'object') return { state, events: [] };
  if (record.type === 'session') {
    if (record.version !== 4) parserError('dsh_unsupported_version');
    state.sessionId = String(record.id || '');
    state.cwd = String(record.cwd || '');
    // Subagent sessions report back to their parent, whose turns already carry the outcome.
    state.subagent = Number(record.delegationDepth) > 0;
    state.seededBefore = record.isSeeded ? Number(record.createdAt) : 0;
    return { state, events: [] };
  }
  if (state.subagent) return { state, events: [] };
  if (record.type === 'turn/start') {
    startDshTurn(state, record);
    return { state, events: [] };
  }
  if (!state.turn) return { state, events: [] };
  const data = record.data;
  if (record.type === 'user/message') {
    if (!data || !data.source) parserError('dsh_invalid_user_message');
    if (data.source.kind === 'user') addDshPrompt(state, record);
    return { state, events: [] };
  }
  if (record.type === 'assistant/message') {
    if (!data || !data.message) parserError('dsh_invalid_assistant_message');
    const text = dshText(data.message.content, 'dsh_invalid_assistant_message');
    if (text) state.turn = { ...state.turn, assistantResponse: text };
    return { state, events: [] };
  }
  if (record.type === 'turn/end') return { state, events: endDshTurn(state) };
  return { state, events: [] };
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
  parseDshRecord,
};
