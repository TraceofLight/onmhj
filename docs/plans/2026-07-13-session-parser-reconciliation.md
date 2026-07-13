# AI Session Parser Reconciliation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild canonical Codex and Claude turns without synthetic protocol messages, preserve complete human evidence, and remove stale parser output only from the current device's successfully replayed sessions.

**Architecture:** Keep provider parsing deterministic and fail closed. A successful parser-version replay records its `(provider, sessionId)` scope and replaces that scope in the local spool; raw publication applies the same current-device scope as an authoritative replacement while preserving every unrelated event.

**Tech Stack:** Node.js standard library, Node test runner, JSONL, Git, Codex plugin CLI.

---

### Task 1: Classify Claude protocol records without losing active work

**Files:**
- Modify: `tests/session-parsers.test.js`
- Modify: `bin/session-parsers.js:116-173`

**Step 1: Write failing parser tests**

Add table-driven sequences for these known internal `user` shapes:

- `{ isMeta: true, sourceToolUseID: 'tool-1', message.content: [{ type: 'text', text: 'Base directory for this skill: ...' }] }`
- string content starting with `<task-notification>`
- string content starting with the compaction continuation sentence
- string content starting with malformed-tool feedback
- exact `[Request interrupted by user]`

Start a real human turn before each ordinary internal record and finish it afterward. Assert the original human prompt and answer are emitted, proving the internal record did not replace `state.turn`.

Add command-envelope cases for `<command-name>/model</command-name>` and `<local-command...>`. Assert they emit nothing, clear a stale active turn, and do not attach a later assistant message to it.

Add one unknown metadata-free user array shape and assert `claude_unclassified_user_message`.

**Step 2: Run the parser tests to verify RED**

Run: `node --test tests/session-parsers.test.js`

Expected: the new Claude assertions fail because internal string/text records currently open or overwrite turns.

**Step 3: Implement the minimal Claude classifier**

Add one small classifier returning `human`, `internal`, or `boundary`:

```js
function claudeUserKind(record, prompt) {
  if (record.isMeta === true || record.sourceToolUseID) return 'internal';
  const text = prompt.trimStart();
  if (text.startsWith('<command-name>') || text.startsWith('<local-command')) return 'boundary';
  if (CLAUDE_INTERNAL_PROMPT_PREFIXES.some(prefix => text.startsWith(prefix))) return 'internal';
  return 'human';
}
```

Keep tool-result users internal. Store `record.sessionId` in parser state before classification. Internal records preserve `state.turn`; boundaries delete it. Only `human` records open a canonical turn. Throw a content-free parser error for unrecognized relevant shapes.

**Step 4: Run focused tests to verify GREEN**

Run: `node --test tests/session-parsers.test.js`

Expected: all parser tests pass.

**Step 5: Commit**

Commit `tests/session-parsers.test.js` and `bin/session-parsers.js` with subject `fix(parser): exclude Claude protocol records` and the required Korean body.

### Task 2: Keep answerless Codex completions pending

**Files:**
- Modify: `tests/session-parsers.test.js`
- Modify: `bin/session-parsers.js:87-113`

**Step 1: Write the failing test**

Parse a normal Codex `task_started` and `user_message`, followed by `task_complete` with `last_agent_message: ''`. Assert one event with the complete prompt, `status: 'pending'`, and no `assistantResponse` property.

**Step 2: Run the exact test to verify RED**

Run: `node --test --test-name-pattern="answerless Codex" tests/session-parsers.test.js`

Expected: FAIL because the parser currently emits `status: 'complete'` with an empty response.

**Step 3: Implement the minimal status rule**

After validating that the selected response is a string, set status from its content:

```js
status: assistantResponse ? 'complete' : 'pending',
```

Only include `assistantResponse` in the returned turn when it is non-empty.

**Step 4: Run parser tests to verify GREEN**

Run: `node --test tests/session-parsers.test.js`

Expected: all parser tests pass.

**Step 5: Commit**

Commit both files with subject `fix(parser): keep answerless Codex turns pending` and the required Korean body.

### Task 3: Replace stale local events after a successful replay

**Files:**
- Modify: `tests/session-ingestion.test.js`
- Modify: `bin/onmhj.js:19,420-594`

**Step 1: Write failing ingestion tests**

Create a version-4 cursor plus a stale local `AISessionTurn` for the same Claude session. Replay a transcript whose new parser emits only the real turn. Assert:

- the stale synthetic `sourceId` is removed;
- the real turn remains;
- the cursor records parser version `5` and the reconciled `provider/sessionId` scope.

Add a replay transcript with malformed JSON. Assert the old canonical event remains, the cursor stays replayable from the old parser version, and quarantine exists.

**Step 2: Run ingestion tests to verify RED**

Run: `node --test tests/session-ingestion.test.js`

Expected: stale events remain and failed replay advances the migration cursor.

**Step 3: Implement successful-replay reconciliation**

- Increment `SESSION_PARSER_VERSION` to `5`.
- During a version restart, buffer normalized turns instead of writing them line by line.
- Collect `(provider, sessionId)` from emitted turns and parser state.
- On successful EOF, rewrite local event files by removing only transcript-derived `AISessionTurn` rows matching `cfg.deviceId`, provider, and session ID; then upsert the buffered complete/pending set.
- Store the reconciled session scopes in the file cursor.
- On replay failure, retain the old cursor version and canonical set so the next run restarts from zero.
- Keep the existing incremental upsert path unchanged for a current-version cursor.

Use small helpers for scope keys and event-file rewriting; do not generalize this into a new storage layer.

**Step 4: Run focused tests to verify GREEN**

Run: `node --test tests/session-ingestion.test.js tests/session-parsers.test.js`

Expected: all focused tests pass.

**Step 5: Commit**

Commit the ingestion files with subject `fix(sessions): replace replayed canonical turns` and the required Korean body.

### Task 4: Reconcile current-device raw publication

**Files:**
- Modify: `tests/session-ingestion.test.js`
- Modify: `bin/onmhj.js:986-1011,1360-1395`
- Modify: `README.md:110-112`
- Modify: `docs/README.ko.md:110-112`

**Step 1: Write the failing publication test**

Seed one raw date with:

- a stale Claude synthetic turn in a reconciled current-device session;
- an existing current-device real turn in that same session;
- another session from the current device;
- the same session ID from another device;
- a manual import and Git event.

Seed cursor reconciliation metadata and the new local real turn. Publish raw sessions and assert only the reconciled current-device session is replaced. Assert the other device, other session, manual import, and Git event remain. Include a date containing only a stale reconciled event so publication must delete that file's stale row even without a new local event on that date.

**Step 2: Run the exact test to verify RED**

Run: `node --test --test-name-pattern="reconciles current-device" tests/session-ingestion.test.js`

Expected: FAIL because `mergeEvents` preserves absent stored `sourceId` values.

**Step 3: Implement scoped raw replacement**

- Load reconciled scopes from current parser-version cursors.
- Enumerate the union of local event dates and existing raw dates that contain a matching current-device transcript event.
- Before `mergeEvents`, filter stored `AISessionTurn` rows only when their device/provider/session key is reconciled by this device.
- Merge the complete current local set for that date.
- Preserve the raw-only command's existing single commit/push behavior and report-artifact isolation.
- Document that successful parser-version replays are authoritative only for their device session scopes.

**Step 4: Run focused tests to verify GREEN**

Run: `node --test tests/session-ingestion.test.js`

Expected: all ingestion and publication tests pass.

**Step 5: Commit**

Commit code, tests, and docs with subject `fix(sessions): reconcile published device scopes` and the required Korean body.

### Task 5: Verify, refresh, and publish the plugin

**Files:**
- Modify through helper: `.codex-plugin/plugin.json`
- Modify through helper if mirrored: marketplace metadata identified by `plugin-creator`

**Step 1: Run full verification**

Run:

```powershell
node --check bin/session-parsers.js
node --check bin/onmhj.js
node --test tests/*.test.js
node .\bin\onmhj.js selftest
git diff --check
```

Expected: zero failures; the existing POSIX executable test may remain skipped on Windows.

**Step 2: Review the surgical diff**

Run: `git diff main...HEAD --stat` and `git diff main...HEAD`.

Expected: every changed line belongs to classification, pending status, replay reconciliation, scoped publication, tests, docs, or cache refresh.

**Step 3: Apply `plugin-creator` update flow**

Read and follow `C:\Users\heejun_kim\.codex\skills\.system\plugin-creator\SKILL.md`. Refresh the CLI cachebuster, validate the plugin with the repository's established hook exception, and reinstall `onmhj@onmhj-local` without opening a visible terminal window.

**Step 4: Verify installed source parity**

Compare hashes for the updated parser/runtime/manifest between this worktree and the installed plugin cache. Run the installed plugin's focused tests or CLI selftest required by the skill.

**Step 5: Integrate and push**

Fetch `origin`, rebase the feature branch if needed, merge it into `main` without discarding remote or user changes, rerun the focused verification, and push `main`. Do not regenerate or publish `daily/` or `reports/` during this task.
