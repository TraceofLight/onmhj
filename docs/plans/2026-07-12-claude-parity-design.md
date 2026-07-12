# Claude Runtime Parity Design

## Goal

Generate complete onmhj reports on a Claude-only machine by reusing the active Claude Code login. Preserve the existing Codex and API behavior.

## Provider Selection

Keep `reportAuth=agent` as the user-facing default. Select the native agent from the plugin runtime:

- `CLAUDE_PLUGIN_ROOT` present: use Claude Code.
- `CODEX_PLUGIN_ROOT` present: use Codex.
- Neither present: preserve the current Codex default.

The detached report worker inherits the triggering hook or command environment, so queued work uses the same provider. `ONMHJ_CLAUDE_EXECUTABLE` provides the same executable override role as `ONMHJ_CODEX_EXECUTABLE` without adding a new config command.

## Claude Agent Backend

Run Claude Code non-interactively with the existing report prompt on stdin. Use safe mode, disable tools, disable session persistence and browser integration, and request text output. Run in the same isolated temporary directory and with the same bounded timeout as the Codex backend.

Do not use Claude `--bare` mode because it disables OAuth and keychain authentication. Remove nested-session marker variables from the child environment before launch so the detached report process can use Claude independently.

Both native backends share prompt construction, secret redaction, report validation, and artifact publication. A missing executable, missing login, timeout, non-zero exit, or invalid report fails the job. Existing ordered retry behavior applies. No report or confirmation is committed on failure.

## Claude Plugin Packaging

Give Claude a dedicated `hooks/hooks.json` using Claude's command-plus-args hook contract and `${CLAUDE_PLUGIN_ROOT}`. Keep `.codex/hooks.json` for Codex. Rely on Claude's default discovery for `hooks/hooks.json`; the current Claude loader rejects an explicit manifest reference to that same standard file as a duplicate.

Bump the Claude plugin version so the installed `0.1.11` cache updates. Refresh marketplace metadata and installation documentation. Document Claude's namespaced commands:

- `/onmhj:onmhj`
- `/onmhj:ejmhj`

The namespace is Claude platform behavior; command effects remain identical.

## Verification

- Unit tests for provider selection, Claude executable override, arguments, child environment, success, timeout, authentication failure, and validation failure.
- Hook tests using `CLAUDE_PLUGIN_ROOT` for `SessionStart` and `UserPromptSubmit`.
- Strict Claude plugin validation and component discovery.
- Existing report, scheduling, self-test, and Codex hook suites.
- Claude plugin update followed by installed-version and cache-hash verification.
- Authenticated end-to-end `--no-push` smoke test when Claude login is available. This machine currently reports no Claude login, so lack of credentials must remain an explicit verification limitation rather than weakening tests or using API credentials.

## Compatibility

- Existing report files remain unchanged.
- Existing Codex agent and API configurations keep their behavior.
- Storage paths, raw/daily/report contracts, ordered retries, and confirmation rules remain unchanged.
- No new user command or required configuration is added.
