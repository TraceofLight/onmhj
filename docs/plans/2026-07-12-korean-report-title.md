# Korean Report Title Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change the Korean final-report heading to `# YYYY-MM-DD 뭐 했지`, migrate every existing report by changing only its first line, and publish the updated plugin and documentation.

**Architecture:** Keep the existing language-specific report contract. Change only the Korean title constant, then use the existing prompt and validator as the single source of truth. Apply a one-time guarded storage migration that preserves all bytes after the first line.

**Tech Stack:** Node.js standard library, Node test runner, Git, Codex plugin CLI, Markdown.

---

### Task 1: Prove the Korean title contract

**Files:**
- Modify: `tests/report-generation.test.js`
- Modify: `tests/report-scheduling.test.js`

**Step 1: Write the failing test**

Change Korean fixtures and assertions to require `# YYYY-MM-DD 뭐 했지`. Keep the English fixture and `Yesterday's work` assertions unchanged.

**Step 2: Run test to verify it fails**

Run: `node --test tests/report-generation.test.js tests/report-scheduling.test.js`

Expected: Korean prompt/validation tests fail because production still emits and accepts `어제 뭐 했지`.

**Step 3: Commit the failing tests only after observing RED**

Do not commit until production reaches GREEN; preserve the RED command output as verification evidence.

### Task 2: Implement the minimal contract change

**Files:**
- Modify: `bin/onmhj.js`
- Modify: `tests/report-generation.test.js`
- Modify: `tests/report-scheduling.test.js`

**Step 1: Change production contract**

Set `REPORT_CONTRACTS.ko.title` to `뭐 했지`. Update the remaining hard-coded self-test heading. Do not change English behavior, sections, filenames, daily rendering, or scheduling.

**Step 2: Run focused tests**

Run: `node --test tests/report-generation.test.js tests/report-scheduling.test.js`

Expected: all focused tests pass.

**Step 3: Run self-test**

Run: `node bin/onmhj.js selftest`

Expected: `selftest ok`.

**Step 4: Commit**

Commit code and tests using the repository commit format.

### Task 3: Synchronize project documentation and plugin version

**Files:**
- Modify: `docs/plans/2026-07-12-automatic-final-reports-design.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `CHANGELOG.md`
- Modify any additional exact-title reference found by `rg`

**Step 1: Update current contract references**

Replace Korean title examples with `# YYYY-MM-DD 뭐 했지`. Record the title-contract change in the changelog.

**Step 2: Refresh cachebuster**

Run the plugin-creator `update_plugin_cachebuster.py` helper against the feature worktree. Preserve base version `0.1.12`.

**Step 3: Validate plugin**

Run the plugin-creator `validate_plugin.py` helper.

**Step 4: Commit**

Commit documentation and manifest changes.

### Task 4: Migrate storage reports without changing bodies

**Files:**
- Modify: `D:/Projects/Github/onmhj-storage/reports/*.md`

**Step 1: Verify migration preconditions**

Require 254 report files. Require every filename date to match an exact first line `# YYYY-MM-DD 어제 뭐 했지`. Record a SHA-256 hash of every byte after the first newline.

**Step 2: Replace only first lines**

Use a one-time Node standard-library script. Abort on any unexpected file. Replace the exact first line with `# YYYY-MM-DD 뭐 했지`.

**Step 3: Verify migration**

Require 254 new headings, zero old headings, unchanged body hashes, and a Git diff containing only one removed and one added heading line per report.

**Step 4: Commit storage**

Commit all 254 report files with the repository commit format. Defer the storage push until every registered client is updated or confirmed inactive in Task 6.

### Task 5: Update pwiki

**Files:**
- Modify: `D:/Projects/Github/my-wiki/personal/onmhj/index.md`
- Modify: `D:/Projects/Github/my-wiki/log.md`

**Step 1: Create an ignored project-local wiki worktree**

Use `D:/Projects/Github/my-wiki/.worktrees/onmhj-report-title` on branch `wiki/onmhj-report-title` after verifying `.worktrees` is ignored.

**Step 2: Update the title contract and verification record**

Change the template to `# YYYY-MM-DD 뭐 했지`. Record the guarded 254-file migration and the unchanged English contract.

**Step 3: Append one log entry and commit**

Follow pwiki schema and commit format.

### Task 6: Verify, review, merge, and reinstall

**Files:**
- Verify all changed files

**Step 1: Run full verification**

Run:

```text
node --check bin/onmhj.js
node --test tests/*.test.js
node bin/onmhj.js selftest
git diff --check
```

Expected: 30 or more tests pass, self-test passes, no whitespace errors.

**Step 2: Review**

Request an independent code and migration review. Resolve Critical/Important findings.

**Step 3: Confirm no old worker remains**

Confirm no worker using the old report-title contract is running before deployment.

**Step 4: Merge and push code**

Merge the feature branch into synchronized code `main`, re-run verification on merged code, and push code `main`.

**Step 5: Reinstall the Windows plugin**

Run `codex plugin add onmhj@onmhj-local`. Confirm installed version and source/cache hashes.

**Step 6: Update every other registered client**

Update every other registered client to the new contract or verify that it is inactive, including `mba-traceoflight.local`. Do not push storage while any active client can still write the old title.

**Step 7: Push storage**

Push the already committed 254-report migration to storage `main` only after Step 6 succeeds.

**Step 8: Merge and push wiki**

Merge the wiki branch into synchronized wiki `main` and push wiki `main`.

**Step 9: Final validation**

Validate all 254 reports with the installed plugin's new Korean contract. Confirm code, storage, and wiki are clean and synchronized with upstream.

### Task 7: Windows Shutdown Cancelled

**Step 1: Take no shutdown action**

The latest user instruction cancels Windows shutdown. Do not schedule or perform any shutdown action after completion.
