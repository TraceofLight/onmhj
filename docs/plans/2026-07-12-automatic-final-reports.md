# Automatic Final Reports Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate and validate `reports/<work-date>.md` automatically through Codex or an OpenAI-compatible API, and confirm a date only after all required artifacts are committed successfully.

**Architecture:** Keep deterministic event merging and daily rendering in `flush`. Add one shared full-report pipeline used by `ejmhj` and report jobs. Select a small report backend from existing configuration, validate its Markdown output, and include the report plus device confirmation in the same git commit before advancing local confirmation.

**Tech Stack:** Node.js standard library, Node test runner, Codex CLI, OpenAI-compatible HTTP API.

---

### Task 1: Report contract and prompt

**Files:**
- Modify: `bin/onmhj.js`
- Create: `tests/report-generation.test.js`

**Step 1:** Write failing tests for the shared Korean report prompt and required-section validation.

**Step 2:** Run `node --test tests/report-generation.test.js` and confirm failures because exports do not exist.

**Step 3:** Implement `buildReportPrompt` and `validateReport` with the six required sections and exact work-date heading.

**Step 4:** Run the focused test and confirm pass.

### Task 2: Agent and API backends

**Files:**
- Modify: `bin/onmhj.js`
- Modify: `tests/report-generation.test.js`

**Step 1:** Add failing tests using injected command and HTTP runners for agent output, API output, missing configuration, and invalid responses.

**Step 2:** Run the focused test and confirm expected failures.

**Step 3:** Implement minimal `generateReport` dispatch. Agent mode runs `codex exec` with stdout capture. API mode posts chat-completions JSON with the configured bearer key.

**Step 4:** Run focused tests and confirm pass.

### Task 3: Full report pipeline and confirmation ordering

**Files:**
- Modify: `bin/onmhj.js`
- Modify: `tests/report-generation.test.js`
- Modify: `tests/report-scheduling.test.js`

**Step 1:** Add failing integration tests proving `ejmhj` writes raw, daily, and report for the same work date, and that report failure does not write confirmation.

**Step 2:** Add a failing scheduling test proving a previously completed date with a missing report becomes pending again.

**Step 3:** Run focused tests and confirm expected failures.

**Step 4:** Split deterministic artifact preparation from git publication. Implement the full pipeline so report and device confirmation are staged together and local confirmation advances only after success.

**Step 5:** Update worker and `ejmhj` to call the full pipeline. Keep `flush` raw/daily-only.

**Step 6:** Run focused tests and confirm pass.

### Task 4: Documentation and self-test

**Files:**
- Modify: `README.md`
- Modify: `docs/README.ko.md`
- Modify: `docs/installation.md`
- Modify: `commands/ejmhj.md`
- Modify: `commands/ejmhj.toml`
- Modify: `bin/onmhj.js`
- Modify: `D:/Projects/Github/my-wiki/personal/onmhj/index.md`
- Modify: `D:/Projects/Github/my-wiki/log.md`

**Step 1:** Update storage and command documentation to distinguish daily evidence from final reports.

**Step 2:** Document agent/API automatic generation, retry semantics, and confirmation requirements.

**Step 3:** Update self-test to assert report creation before confirmation.

**Step 4:** Run `node bin/onmhj.js selftest` and confirm pass.

### Task 5: Verification and plugin refresh

**Files:**
- Modify: `.codex-plugin/plugin.json`

**Step 1:** Run `node --check bin/onmhj.js`.

**Step 2:** Run `node --test tests/*.test.js`.

**Step 3:** Run `node bin/onmhj.js selftest`.

**Step 4:** Refresh the Codex cachebuster version without overwriting the user's existing manifest change.

**Step 5:** Reinstall `onmhj@onmhj-local` and inspect installed plugin files.

**Step 6:** Run a fresh-session smoke test and verify hook capture plus automatic missing-report scheduling without exposing secrets.

**Step 7:** Commit only task-related files with the required commit format and push both code and wiki changes if their worktrees are otherwise safe.
