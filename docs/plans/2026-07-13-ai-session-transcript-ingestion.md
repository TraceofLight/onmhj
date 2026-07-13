# AI Session Transcript Ingestion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ingest canonical Codex, Claude, and OpenAI-compatible conversation turns with final assistant answers, quarantine parser failures before report confirmation, and preserve existing report content during regeneration.

**Architecture:** Add one deterministic parser module beside the existing Node CLI. The CLI incrementally scans local transcript JSONL with per-file cursors, upserts normalized turns into the existing local event spool, and blocks report confirmation for unresolved affected dates. Existing raw/daily/report publication remains intact, with sourceId last-writer merge and additive report validation.

**Tech Stack:** Node.js standard library, Node test runner, JSONL, Git, Codex plugin CLI.

---

### Task 1: Provider parser fixtures and adapters

**Files:**
- Create: `bin/session-parsers.js`
- Create: `tests/session-parsers.test.js`
- Create: `tests/fixtures/codex-transcript.jsonl`
- Create: `tests/fixtures/claude-transcript.jsonl`

**Step 1: Create minimal sanitized transcript fixtures**

Add Codex records for `session_meta`, `task_started`, canonical `user_message`, duplicate response items, commentary, `final_answer`, and `task_complete`. Add Claude records for one human prompt, split thinking/text/tool-use records, synthetic `tool_result` user records, and an `end_turn` text record.

**Step 2: Write failing parser tests**

Assert:

- Codex emits one turn from `event_msg` records and ignores response-item duplicates.
- Claude treats tool results as synthetic and emits one human turn.
- Both adapters return stable provider/session/turn IDs, prompt, final answer, timestamp, cwd, and complete status.
- Relevant malformed shapes throw a parser error without embedding text content in the error message.
- OpenAI-compatible normalization accepts `reasoning_content` and vLLM `reasoning`, JSON-string and object arguments, and rejects raw DSML.

**Step 3: Run tests to verify RED**

Run: `node --test tests/session-parsers.test.js`

Expected: FAIL because `bin/session-parsers.js` does not exist.

**Step 4: Implement minimal provider adapters**

Export small pure functions:

```js
parseCodexRecord(record, state)
parseClaudeRecord(record, state)
normalizeOpenAIExchange(capture)
```

Return `{ state, events }`. Exclude reasoning, developer/system content, raw tool output, and provider extension fields.

**Step 5: Run tests to verify GREEN**

Run: `node --test tests/session-parsers.test.js`

Expected: all parser tests pass.

**Step 6: Commit**

Commit parser module, fixtures, and tests using the repository commit format.

### Task 2: Event upsert and multi-device merge

**Files:**
- Modify: `bin/onmhj.js`
- Create: `tests/session-ingestion.test.js`

**Step 1: Write failing event-store tests**

Assert:

- a completed `sourceId` event replaces a pending local event;
- merged stored raw plus local events uses the later `sourceId` value;
- legacy `UserPromptSubmit` events are removed only for sessions having canonical `AISessionTurn` events;
- `assistantResponse` is secret-redacted;
- GitCommit and manual events remain present.

**Step 2: Run tests to verify RED**

Run: `node --test tests/session-ingestion.test.js`

Expected: FAIL because sourceId upsert and canonical-session replacement do not exist.

**Step 3: Implement minimal event-store changes**

Add `upsertEventRecord`. Make `mergeEvents` last-writer-wins for `sourceId`, retain deterministic dedupe for other events, and filter legacy prompt events only after canonical turns are available. Extend sanitization/import normalization for `assistantResponse`, provider, turnId, status, and schemaVersion.

**Step 4: Run tests to verify GREEN**

Run: `node --test tests/session-ingestion.test.js tests/report-generation.test.js tests/report-scheduling.test.js`

Expected: focused suites pass.

**Step 5: Commit**

Commit event-store code and tests.

### Task 3: Incremental transcript ingestion and quarantine

**Files:**
- Modify: `bin/onmhj.js`
- Modify: `tests/session-ingestion.test.js`

**Step 1: Write failing cursor and quarantine tests**

Using temporary state and transcript directories, assert:

- first scan writes normalized turns and a byte cursor;
- second unchanged scan writes no duplicate;
- appended completion replaces a pending turn;
- malformed JSON stops at its starting offset and writes metadata-only quarantine;
- successful retry removes quarantine and advances the cursor;
- an unresolved failure for the requested date rejects full report execution before confirmation.

**Step 2: Run tests to verify RED**

Run: `node --test tests/session-ingestion.test.js`

Expected: FAIL because session scanning and quarantine do not exist.

**Step 3: Implement JSONL cursor reader**

Use `fs.createReadStream({ start })` and Buffer newline boundaries. Track the byte offset before each record. Persist cursor state only through successfully handled records.

**Step 4: Implement discovery and provider dispatch**

Discover root Codex `~/.codex/sessions/**/*.jsonl` and Claude `~/.claude/projects/**/*.jsonl`, excluding Claude `subagents` for primary ingestion. Accept injected roots in tests.

**Step 5: Implement quarantine and retry**

Write one safe JSON record per failed source under `stateDir/session-ingest/quarantine/`. Store provider, path hash, offset, affected date, parser version, schema signature, and error code only. Clear it after successful processing beyond the failure.

**Step 6: Add command and report gate**

Add `onmhj sessions`. Run ingestion before `runFullReportUnlocked` prepares daily evidence. Reject confirmation when quarantine affects the report date.

**Step 7: Run tests to verify GREEN**

Run: `node --test tests/session-ingestion.test.js tests/report-generation.test.js tests/report-scheduling.test.js`

Expected: focused suites pass.

**Step 8: Commit**

Commit ingestion, command, quarantine, and tests.

### Task 4: OpenAI-compatible capture import

**Files:**
- Modify: `bin/onmhj.js`
- Modify: `tests/session-ingestion.test.js`

**Step 1: Write failing import tests**

Import nested `{ request, response, provider, tsUtc, cwd }` captures and assert canonical `AISessionTurn` output. Cover GLM object arguments, official DeepSeek JSON-string arguments, vLLM `reasoning`, missing content, and DSML rejection.

**Step 2: Run tests to verify RED**

Run: `node --test tests/session-ingestion.test.js`

Expected: OpenAI capture import tests fail against generic manual normalization.

**Step 3: Dispatch compatible captures through the adapter**

Keep existing normalized event import unchanged. When both `request` and `response` exist, call `normalizeOpenAIExchange`, add local device/timezone/git metadata, redact, and upsert by response/request ID.

**Step 4: Run tests to verify GREEN**

Run: `node --test tests/session-ingestion.test.js`

Expected: all ingestion tests pass.

**Step 5: Commit**

Commit import adapter integration and tests.

### Task 5: Assistant evidence and additive report regeneration

**Files:**
- Modify: `bin/onmhj.js`
- Modify: `tests/report-generation.test.js`

**Step 1: Write failing daily evidence test**

Assert deterministic daily output includes canonical user prompts and final assistant responses but excludes reasoning and raw tool output.

**Step 2: Write failing report-preservation tests**

Assert an existing valid report is included in the report prompt. Reject generated output missing any prior non-heading content line. Accept output preserving all previous content and adding new evidence. Verify rejection leaves the existing file and confirmation untouched.

**Step 3: Run tests to verify RED**

Run: `node --test tests/report-generation.test.js`

Expected: assistant evidence and preservation assertions fail.

**Step 4: Implement daily response rendering**

Add one localized assistant-results label and render redacted `assistantResponse` values beside canonical prompts.

**Step 5: Implement additive report validation**

Read an existing valid report before generation. Add it to the prompt with a verbatim-preservation rule. After normal validation, require every prior non-empty non-heading line to remain present. Write only after both validations succeed.

**Step 6: Run tests to verify GREEN**

Run: `node --test tests/report-generation.test.js tests/report-scheduling.test.js`

Expected: report suites pass.

**Step 7: Commit**

Commit daily/report behavior and tests.

### Task 6: Documentation and selftest

**Files:**
- Modify: `README.md`
- Modify: `docs/README.ko.md`
- Modify: `docs/installation.md`
- Modify: `bin/onmhj.js`
- Modify: `CHANGELOG.md`

**Step 1: Document session ingestion**

Document `onmhj sessions`, normalized turn fields, prompt modes, OpenAI-compatible capture import shape, cursor/quarantine paths, and confirmation blocking.

**Step 2: Document regeneration safety**

State that raw/daily remain additive/deterministic and existing report content cannot be removed by automatic regeneration.

**Step 3: Extend selftest**

Add a compact transcript ingestion and additive-report validation assertion using temporary files.

**Step 4: Run documentation-adjacent verification**

Run:

```powershell
node --check bin/onmhj.js
node --check bin/session-parsers.js
node bin/onmhj.js selftest
```

Expected: syntax success and `selftest ok`.

**Step 5: Commit**

Commit docs and selftest changes.

### Task 7: Full verification and plugin refresh

**Files:**
- Modify: `.codex-plugin/plugin.json`

**Step 1: Run full verification**

Run:

```powershell
node --check bin/onmhj.js
node --check bin/session-parsers.js
node --test tests/*.test.js
node bin/onmhj.js selftest
git diff --check
```

Expected: all tests pass, only the Windows POSIX mode check is skipped, selftest prints `selftest ok`, and no whitespace errors exist.

**Step 2: Validate plugin source**

Run the Codex and Claude plugin validators used by the existing repository tests. Expected: both plugin shapes accepted.

**Step 3: Refresh cachebuster**

Run `plugin-creator/scripts/update_plugin_cachebuster.py` against the source plugin. Preserve the base version and replace only the Codex suffix.

**Step 4: Commit the cachebuster**

Commit the manifest-only refresh using the repository commit format.

**Step 5: Integrate and push**

Fast-forward the verified branch into `main`, push `onmhj` and `pwiki` main, and confirm both worktrees are clean.

**Step 6: Reinstall**

Read the local marketplace name and run `codex plugin add onmhj@<marketplace>`. Verify installed version and SHA-256 equality for manifest, parser, CLI, hooks, and command files.

**Step 7: Local smoke without historical publication**

Set the active local config to `promptMode=full`, run `onmhj sessions` against a bounded fresh transcript or fixture-backed temporary config, and confirm normalized prompt/final-answer capture. Do not bulk-regenerate historical storage reports in this task.
