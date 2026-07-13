# Lossless AI Session Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove prompt capture modes and persist every captured canonical user prompt and final assistant response without arbitrary length limits.

**Architecture:** Keep existing transcript adapters and secret redaction. Remove mode branching at the hook and normalized-turn boundaries, ignore obsolete configuration keys, and reject obsolete CLI flags. Preserve legacy preview fields only as read compatibility for already-truncated history.

**Tech Stack:** Node.js standard library, `node:test`, Codex plugin manifest and local marketplace tooling

---

### Task 1: Lock the lossless contract with failing tests

**Files:**
- Modify: `tests/session-ingestion.test.js`
- Modify: `tests/codex-hooks.test.js`

**Step 1: Write the failing transcript test**

Add a test using a configuration containing `promptMode: "off"`, a prompt longer than 300 characters, and a final answer longer than 300 characters. Assert the emitted `AISessionTurn` contains complete `prompt` and `assistantResponse` values and no preview fields.

**Step 2: Write the failing hook test**

Run `bin/onmhj.js hook UserPromptSubmit` against a temporary legacy `promptMode: "preview"` configuration with a prompt longer than 300 characters. Assert the local event contains the complete `prompt` and no `promptPreview`.

**Step 3: Write the failing CLI test**

Run `bin/onmhj.js config --prompt=off` and assert it fails with a message explaining that prompt capture is always full.

**Step 4: Verify RED**

Run: `node --test tests/session-ingestion.test.js tests/codex-hooks.test.js`

Expected: FAIL because `off` omits transcript content, `preview` truncates hook content, and the CLI still accepts `--prompt`.

### Task 2: Remove capture modes

**Files:**
- Modify: `bin/onmhj.js`
- Test: `tests/session-ingestion.test.js`
- Test: `tests/codex-hooks.test.js`

**Step 1: Implement full hook capture**

Make prompt parsing always return `{ prompt: redactSecrets(prompt) }`. Remove the mode parameter and configuration dependency.

**Step 2: Implement full canonical turn capture**

Always write redacted `prompt` and present `assistantResponse` fields in `normalizedSessionEvent`. Remove preview/off branching.

**Step 3: Remove configuration surface**

Remove `promptMode` from config defaults, registration, configuration, status, usage, logs, and selftest. Reject `--prompt=*` with `prompt capture is always full` so old automation fails visibly instead of silently losing content.

**Step 4: Keep legacy import compatibility without new truncation**

Preserve an imported `promptPreview` value as supplied after redaction. Store `raw.text` as full `prompt`. Keep report readers able to consume old preview fields.

**Step 5: Verify GREEN**

Run: `node --test tests/session-ingestion.test.js tests/codex-hooks.test.js`

Expected: PASS.

### Task 3: Update active documentation and fixtures

**Files:**
- Modify: `README.md`
- Modify: `docs/README.ko.md`
- Modify: `docs/installation.md`
- Modify: `tests/claude-hooks.test.js`
- Modify: `tests/report-generation.test.js`
- Modify: `tests/report-scheduling.test.js`

**Step 1: Remove active prompt mode instructions**

Document that captured canonical prompts and final responses are always stored completely after redaction. Document that reasoning and tool arguments remain excluded.

**Step 2: Remove obsolete test configuration fields**

Delete `promptMode` from active test fixtures where it no longer describes behavior. Retain `promptPreview` only in tests exercising legacy-data compatibility.

**Step 3: Verify stale active references are gone**

Run: `rg -n "promptMode|--prompt=|prompt capture defaults|first 300" README.md docs/README.ko.md docs/installation.md tests bin/onmhj.js`

Expected: only intentional legacy compatibility assertions, if any.

### Task 4: Verify and publish the plugin update

**Files:**
- Modify: `.codex-plugin/plugin.json`

**Step 1: Run full verification**

Run: `node --test tests/*.test.js`

Run: `node bin/onmhj.js selftest`

Expected: all tests pass and selftest prints `selftest ok`.

**Step 2: Refresh plugin cachebuster**

Use the plugin-creator cachebuster helper, validate the plugin, and reinstall through the configured local marketplace without opening a visible terminal window.

**Step 3: Verify installed cache**

Compare the source and installed plugin manifest/cache content required by the update workflow.

**Step 4: Commit and push**

Create one implementation commit using the repository commit format, then push `main`.
