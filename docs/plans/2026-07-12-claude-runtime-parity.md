# Claude Runtime Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate complete onmhj reports on Claude-only machines with the active Claude Code login while preserving Codex and API behavior.

**Architecture:** Keep one report prompt, validator, retry queue, and publication pipeline. Select the native agent from the plugin runtime, then invoke either the existing Codex runner or a tool-disabled Claude print-mode runner. Package Claude hooks separately and bump both plugin artifacts so installed caches receive the shared code.

**Tech Stack:** Node.js standard library, Node test runner, Claude Code CLI, Codex CLI, JSON plugin manifests, Git.

---

### Task 1: Prove native provider selection and Claude invocation

**Files:**
- Modify: `tests/report-generation.test.js:83-304`

**Step 1: Write the failing Claude backend test**

Add a test that calls `generateReport()` with:

```js
{
  env: {
    CLAUDE_PLUGIN_ROOT: 'claude-plugin',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  },
  claudeCommand: 'claude-native',
  codexCommand: 'codex-native',
  runAgent(command, args, input, options) {
    invocation = { command, args, input, options };
    return { status: 0, stdout: validReport(), stderr: '' };
  },
}
```

Require `claude-native`, the exact arguments below, report prompt on stdin, deleted nested-session variables, a bounded timeout, and cleanup of the temporary directory:

```js
[
  '-p',
  '--safe-mode',
  '--tools',
  '',
  '--no-session-persistence',
  '--no-chrome',
  '--output-format',
  'text',
]
```

**Step 2: Add compatibility tests**

Require `CODEX_PLUGIN_ROOT` and an environment without either plugin root to keep using the existing Codex command and arguments. Add a Claude non-zero-exit case proving authentication or launch errors surface through the existing `report agent failed` path.

**Step 3: Run focused tests to verify RED**

Run: `node --test tests/report-generation.test.js`

Expected: Claude selection test fails because production always resolves Codex.

### Task 2: Implement minimal runtime-native agent dispatch

**Files:**
- Modify: `bin/onmhj.js:823-932`
- Modify: `tests/report-generation.test.js`

**Step 1: Add small provider helpers**

Implement provider selection and Claude resolution without new user configuration:

```js
function nativeAgentProvider(env = process.env) {
  return env.CLAUDE_PLUGIN_ROOT ? 'claude' : 'codex';
}

function resolveClaudeExecutable(env = process.env) {
  return env.ONMHJ_CLAUDE_EXECUTABLE || 'claude';
}

function claudeAgentEnvironment(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return childEnv;
}
```

Keep Codex as the standalone fallback. Do not add `reportAgent`, aliases, executable scanning, or API fallback.

**Step 2: Dispatch inside `generateReport()`**

For `reportAuth=agent`, select Claude only when `CLAUDE_PLUGIN_ROOT` is present. Claude uses `deps.claudeCommand || resolveClaudeExecutable(env)`, the Task 1 arguments, and `claudeAgentEnvironment(env)`. Codex keeps its existing executable and arguments. Both use the same prompt, temporary directory, timeout, output validation, and error handling.

**Step 3: Run focused tests to verify GREEN**

Run: `node --test tests/report-generation.test.js`

Expected: all report generation tests pass.

**Step 4: Run syntax and self-test**

Run:

```text
node --check bin/onmhj.js
node bin/onmhj.js selftest
```

Expected: syntax success and `selftest ok`.

**Step 5: Commit**

Commit `bin/onmhj.js` and `tests/report-generation.test.js` using the repository commit format.

### Task 3: Add Claude-native hooks and integration tests

**Files:**
- Create: `hooks/hooks.json`
- Create: `tests/claude-hooks.test.js`
- Modify: `.claude-plugin/plugin.json:10`

**Step 1: Write failing package tests**

Require the Claude manifest to omit its own `hooks` property and the default `hooks/hooks.json` to exist. Require `SessionStart` and `UserPromptSubmit` command hooks to use:

```json
{
  "type": "command",
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/bin/onmhj.js", "hook", "EVENT_NAME"],
  "timeout": 5
}
```

Execute both handlers with a temporary `ONMHJ_CONFIG`, resolved plugin-root argument, and representative stdin JSON. Require exit status 0 and recorded hook events.

**Step 2: Run Claude hook test to verify RED**

Run: `node --test tests/claude-hooks.test.js`

Expected: failure because `hooks/hooks.json` does not exist and the manifest still has an explicit hook reference.

**Step 3: Add the dedicated hook file**

Create Claude-native `SessionStart` and `UserPromptSubmit` definitions. Limit the `SessionStart` matcher to `startup|resume|clear|compact`. Do not add `Stop`; current automatic scheduling contract already runs at session start.

**Step 4: Use Claude's default hook auto-discovery**

Remove the Claude manifest's explicit `hooks` reference. Claude discovers `hooks/hooks.json` automatically, and referencing the default file in the manifest would load it twice. Leave `.codex/hooks.json` unchanged.

**Step 5: Verify GREEN and strict validation**

Run:

```text
node --test tests/claude-hooks.test.js tests/codex-hooks.test.js
claude plugin validate . --strict
```

Expected: both hook suites pass and Claude validation succeeds.

**Step 6: Commit**

Commit hook file, manifest cleanup, and tests.

### Task 4: Synchronize versions and documentation

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `README.md`
- Modify: `docs/README.ko.md`
- Modify: `docs/installation.md`
- Modify: `CHANGELOG.md`

**Step 1: Update package metadata**

Set Claude version to `0.1.13`. Set the Codex base version to `0.1.13`, then run the plugin-creator cachebuster helper:

```text
python C:/Users/heejun_kim/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py D:/Projects/Github/onmhj/.worktrees/claude-runtime-parity
```

Update the Claude marketplace description to mention final reports and ordered retries. Do not hand-edit marketplace source or installation policy.

**Step 2: Document platform parity**

Document:

- Claude commands `/onmhj:onmhj` and `/onmhj:ejmhj`.
- Runtime-native agent selection.
- `ONMHJ_CLAUDE_EXECUTABLE` override.
- Claude update and `/reload-plugins` flow.
- Claude-only generation requires an active Claude login; API mode remains shared.

Keep storage, title, and confirmation contracts unchanged.

**Step 3: Validate metadata and references**

Run:

```text
rg -n "Codex executable|Claude|/ejmhj|/onmhj|0\.1\.1[123]" README.md docs CHANGELOG.md .claude-plugin .codex-plugin
python C:/Users/heejun_kim/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py D:/Projects/Github/onmhj/.worktrees/claude-runtime-parity
claude plugin validate . --strict
```

Expected: documentation distinguishes native providers, both validators pass, and no stale Claude installation instructions remain.

**Step 4: Commit**

Commit metadata and documentation.

### Task 5: Verify, review, integrate, and reinstall

**Files:**
- Verify all changed files

**Step 1: Run full verification**

Run:

```text
node --check bin/onmhj.js
node --test tests/*.test.js
node bin/onmhj.js selftest
claude plugin validate . --strict
python C:/Users/heejun_kim/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py D:/Projects/Github/onmhj/.worktrees/claude-runtime-parity
git diff --check main...HEAD
```

Expected: all tests pass, both plugin validators pass, self-test passes, no whitespace errors.

**Step 2: Request independent review**

Use `superpowers:requesting-code-review`. Resolve Critical and Important findings, then rerun focused and full verification.

**Step 3: Merge into `main`**

Use `superpowers:finishing-a-development-branch`. Fast-forward `main` after confirming both worktrees are clean. Rerun full verification on merged `main`.

**Step 4: Push code**

Push `main` and verify upstream divergence is `0 0`.

**Step 5: Reinstall Codex plugin**

Read the personal marketplace name with the plugin-creator helper, reinstall `onmhj@<marketplace>`, and compare installed manifest/core/hook hashes with merged source.

**Step 6: Update Claude plugin**

Run:

```text
claude plugin update onmhj@onmhj-local --scope user
claude plugin details onmhj@onmhj-local
```

Require installed version `0.1.13`, two skills, and two hooks. Compare installed `bin/onmhj.js`, `hooks/hooks.json`, and command hashes with merged source. A new Claude session or `/reload-plugins` loads the new cache.

**Step 7: Record live-auth limitation**

Run `claude auth status`. If logged in, execute an isolated `--no-push` smoke fixture. If logged out, do not request credentials or switch to API mode; report that unit, hook, package, and installation verification passed but authenticated model generation could not run on this machine.

**Step 8: Complete goal**

Require clean synchronized `main`, current installed Codex and Claude cache hashes, and no pending implementation work before marking the goal complete.
