# AI Session Transcript Ingestion Design

## Goal

Replace preview-only prompt evidence with deterministic, replayable AI session turns containing the actual user prompt and final assistant response. Preserve multi-device additive raw history, stop report confirmation when relevant transcript parsing is unresolved, and prevent report regeneration from deleting existing report content.

## Normalized Turn Contract

Each parsed conversation turn becomes one `AISessionTurn` event:

```json
{
  "schemaVersion": 1,
  "event": "AISessionTurn",
  "source": "codex-transcript",
  "sourceId": "codex:<session-id>:<turn-id>",
  "provider": "codex",
  "sessionId": "<session-id>",
  "turnId": "<turn-id>",
  "tsUtc": "<ISO timestamp>",
  "localDate": "<configured timezone date>",
  "cwd": "<working directory>",
  "prompt": "<redacted user prompt>",
  "assistantResponse": "<redacted final answer>",
  "status": "complete"
}
```

`sourceId` is the stable upsert key. A pending turn may later be replaced by its completed form. Existing GitCommit and manual events remain unchanged.

Prompt privacy remains configurable:

- `full`: retain the complete redacted canonical user prompt and final answer.
- `preview`: retain previews derived from the canonical user message, not the hook payload prefix.
- `off`: retain only turn metadata.

## Provider Adapters

Provider parsing lives outside the main CLI in one focused parser module.

### Codex

Read the JSONL event stream between `task_started` and `task_complete`.

- User prompt: `event_msg/user_message.message`.
- Final answer: `task_complete.last_agent_message`.
- Fallback for an incomplete tail: `event_msg/agent_message` with `phase=final_answer`.
- Ignore duplicate `response_item` user and assistant messages, developer instructions, reasoning, world state, and compaction summaries.
- A Codex internal rollout may contain `task_started` and `task_complete` without a human prompt. Treat it as context-only only when the turn contains an explicit inter-agent marker or every `response_item` user text block is a known injected context (`recommended_plugins`, `codex_internal_context`, `AGENTS.md`, or `environment_context`). Complete that turn without emitting `AISessionTurn`.
- Treat an exact empty `task_started` → `task_complete` no-op with no intermediate record as context-only because it contains no prompt or recoverable activity.
- Keep unknown prompt-less turns fail closed. Known context blocks classify internal rollouts only; they never become prompt evidence.

### Claude

Read root project transcript JSONL. Subagent files are separate sources and are not folded into the primary conversation in this change.

- Human prompt: `type=user` with string content or `text`/`image` blocks.
- Tool result: `type=user` containing `tool_result`; never treat it as a human prompt.
- Final answer: assistant `text` associated with `stop_reason=end_turn`.
- Follow `uuid` and `parentUuid`; retain stable prompt UUID as the turn key.
- Ignore thinking, attachments, snapshots, queue state, and system summaries.

### OpenAI-compatible

The API defines a transport format, not a local transcript. Import captured request/response JSONL at the client or proxy boundary.

- Prompt: last human `messages[]` entry.
- Final answer: `choices[0].message.content`.
- Reasoning alias: accept `reasoning_content` or vLLM `reasoning`, but do not persist reasoning text.
- Tool arguments: accept a JSON string or object. Invalid JSON or raw DSML is a parse failure.
- Ignore provider extensions such as `prompt_text`, prompt token IDs, routed experts, and raw reasoning.

## Ingestion and Retry

`onmhj sessions` scans known local Codex and Claude transcript roots and accepts OpenAI-compatible capture imports. Processing is incremental by file cursor.

For each input file:

1. Read from the last committed byte offset.
2. Parse complete JSONL records deterministically.
3. Redact secrets before writing normalized events.
4. Upsert local events by `sourceId`.
5. Advance the file cursor only through successfully parsed records.

Malformed JSON or an invalid relevant record writes a quarantine entry containing provider, path, offset, timestamp, schema signature, and error. It must not contain prompt, answer, tool arguments, or secrets. The affected report date cannot advance `confirmedThrough` while the failure is unresolved. A later parser version, changed source file, or explicit retry reprocesses the stopped offset.

Unknown irrelevant metadata is ignored. Unknown user, assistant, or tool record shapes fail closed.

No runtime self-modifying parser. An agent may inspect quarantine evidence, official schemas, and fixtures, then generate a parser patch. Activation, commit, and push remain explicit repository operations.

## Multi-device Merge

Raw history remains additive across devices. `sourceId` duplicates use last-writer replacement so a completed turn replaces its pending version. Other event types retain deterministic deduplication.

When canonical transcript turns exist for a session, legacy hook-only `UserPromptSubmit` previews for that session are excluded from regenerated raw and daily evidence. This removes the 300-character ambient-context failure without deleting unrelated commits or manual events.

## Report Regeneration

Daily evidence is regenerated deterministically from merged raw events and may include both canonical prompts and final assistant results.

If a valid report already exists, it is supplied to the report backend together with new evidence. Regenerated output must:

- satisfy the normal title and section contract;
- preserve every prior non-heading content line verbatim;
- add new confirmed details without deleting old ones.

Validation failure leaves the old report and both local and remote confirmation unchanged.

## Verification

- Fixture tests for Codex duplicate records, completed and incomplete turns, and schema failures.
- Codex regression tests proving known context-only and inter-agent turns are skipped while unknown prompt-less turns remain parse failures.
- Fixture tests for Claude human prompts, tool results, split assistant records, branches, and schema failures.
- OpenAI-compatible tests for GLM-style `reasoning_content`, vLLM `reasoning`, string/object tool arguments, and DSML rejection.
- Cursor, quarantine, retry, sourceId upsert, legacy preview replacement, and confirmation blocking tests.
- Existing-report preservation regression test.
- Full Node suite, selftest, plugin validators, cachebuster reinstall, and installed-cache hash verification.
