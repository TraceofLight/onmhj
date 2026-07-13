# Codex Context-Only Turns Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop known Codex internal/context-only rollouts from creating false transcript quarantines while preserving fail-closed behavior for unknown missing prompts.

**Architecture:** Extend the pure Codex parser with one conservative classifier. Known injected context and inter-agent markers may mark a prompt-less turn internal; `task_complete` then clears that turn without emitting `AISessionTurn`. Actual prompt evidence continues to come only from `event_msg/user_message`.

**Tech Stack:** Node.js standard library, Node test runner, JSONL, Git.

---

### Task 1: Reproduce and fix context-only turn parsing

**Files:**
- Modify: `tests/session-parsers.test.js`
- Modify: `bin/session-parsers.js`

**Step 1: Write failing parser tests**

Add sanitized record sequences for:

- a `task_started` turn whose `response_item` user blocks contain only `recommended_plugins`, `AGENTS.md`, and `environment_context`;
- a prompt-less turn containing `inter_agent_communication_metadata`;
- an unknown prompt-less turn.

Assert the first two sequences emit no event and leave no active turn. Assert the unknown sequence still throws `codex_missing_user_message`.

**Step 2: Run test to verify RED**

Run: `node --test tests/session-parsers.test.js`

Expected: context-only and inter-agent assertions fail with `codex_missing_user_message`.

**Step 3: Implement minimal classifier**

Add a small helper recognizing only these injected text prefixes:

```js
const CODEX_INTERNAL_CONTEXT_PREFIXES = [
  '<recommended_plugins',
  '<codex_internal_context',
  '# AGENTS.md instructions',
  '<environment_context>',
];
```

Mark the current turn internal only when every text block in a `response_item/message/user` record matches a known prefix, or when `inter_agent_communication_metadata` is present. At `task_complete`, skip only an internal turn with no prompt. Keep all unknown prompt-less turns fail closed.

**Step 4: Run focused tests to verify GREEN**

Run: `node --test tests/session-parsers.test.js tests/session-ingestion.test.js`

Expected: all focused tests pass.

**Step 5: Commit parser fix**

Commit only parser and test changes using the repository commit format.

### Task 2: Retry live ingestion and complete current-device replay

**Files:**
- Modify through CLI: `~/.local/state/onmhj/session-ingest/`
- Modify through CLI: `~/.local/state/onmhj/events/`
- Modify once after successful retry: `~/.local/state/onmhj/jobs/reports/confirmed.json`

**Step 1: Run full verification**

Run:

```powershell
node --check bin/session-parsers.js
node --test tests/*.test.js
node .\bin\onmhj.js selftest
git diff --check
```

Expected: no failures; only the existing platform-dependent skip is allowed.

**Step 2: Retry live session ingestion**

Run: `node .\bin\onmhj.js sessions`

Expected: `failures=0`, quarantine count `0`, and all 497 discovered source cursors advance.

**Step 3: Reset only the local confirmation**

Preserve the storage repository's `state/devices/traceoflight.json`. Set local `confirmedThrough` to an empty string in `~/.local/state/onmhj/jobs/reports/confirmed.json` only after ingestion succeeds.

**Step 4: Queue ordered regeneration**

Trigger `SessionStart`. Expected: every candidate date through yesterday becomes pending and the detached worker processes them in date order. Any parser, report, validation, Git, or push failure stops confirmation progress.

**Step 5: Verify rollout state**

Confirm local quarantine remains empty, report jobs are pending/running/completed without silent failures, the report repository remains a valid Git worktree, and existing report content is preserved by validation.

**Step 6: Refresh and publish plugin source**

Refresh the Codex cachebuster, verify installed-cache hashes, fast-forward into `main`, push, and reinstall `onmhj@onmhj-local`.
