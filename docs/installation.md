# Installation

`onmhj` is installed as a local Codex or Claude Code plugin marketplace. Hooks record events locally. `flush` publishes raw evidence to a separate report repo chosen by the user; `ejmhj` and automatic jobs add final reports.

## Prerequisites

- Node.js on `PATH` for non-interactive hook execution.
- One supported agent runtime with plugin support:
  - Codex CLI for Codex installation.
  - Claude Code CLI for Claude Code installation; agent mode requires Claude Code 2.1.169 or newer (`--safe-mode`).
- A git repo for reports, separate from any wiki repo.
- Agent mode requires an active local login for the selected runtime; API mode instead requires configured API credentials.

Example report repo:

```sh
/path/to/onmhj-storage
```

## Codex From Local Checkout

From any directory:

```sh
codex plugin marketplace add /path/to/onmhj
codex plugin add onmhj@onmhj-local
```

Then open `/hooks`, review and trust the `onmhj` lifecycle hooks, and start a new Codex session.

The marketplace manifest lives at:

```txt
.agents/plugins/marketplace.json
```

## Codex From GitHub

After the repo has been pushed, Codex can also install from GitHub:

```sh
codex plugin marketplace add your-github-user/onmhj
codex plugin add onmhj@onmhj-local
```

If the marketplace was already added and the repo changed, refresh it:

```sh
codex plugin marketplace upgrade onmhj-local
codex plugin add onmhj@onmhj-local
```

## Claude Code From Local Checkout

From any directory:

```sh
claude plugin marketplace add /path/to/onmhj
claude plugin install onmhj@onmhj-local
claude plugin enable onmhj@onmhj-local
```

To update an existing user-scope install:

```sh
claude plugin update onmhj@onmhj-local --scope user
```

Run `/reload-plugins` in the current Claude Code session, or start a new session, so the updated commands and hooks load. Claude Code commands are namespaced: `/onmhj:onmhj ...` and `/onmhj:ejmhj [date]`.

## Configure Report Repo

Register the external storage repo:

```sh
node /path/to/onmhj/bin/onmhj.js register /path/to/onmhj-storage --timezone=Asia/Seoul
```

Check config:

```sh
node /path/to/onmhj/bin/onmhj.js status
```

Update timezone without changing the registered repo:

```sh
node /path/to/onmhj/bin/onmhj.js config --timezone=Asia/Seoul
```

Set a stable device id for this computer. It defaults to the hostname when unset:

```sh
node /path/to/onmhj/bin/onmhj.js config --device-id=macbook-pro
```

Set the owner identity used by manual/git-history backfills:

```sh
node /path/to/onmhj/bin/onmhj.js config \
  --owner-name="Your Name" \
  --owner-email=you@example.com
```

Automatic final report generation uses the active plugin runtime's local authentication:

```sh
node /path/to/onmhj/bin/onmhj.js config \
  --report-lang=ko \
  --report-auth=agent \
  --report-agent=auto \
  --report-agent-effort=medium \
  --report-timeout-minutes=15
```

`report-lang` controls the final report contract (`ko` or `en`). It defaults from the user's locale when unset. `report-agent=auto` selects the active plugin runtime's local login; use `codex` or `claude` to override it. Claude defaults to the stable `sonnet` alias and Codex defaults to `gpt-5.6-terra`; use `--report-agent-model=MODEL` when the provider changes its model names. Agent effort defaults to `medium`. Set `ONMHJ_CLAUDE_EXECUTABLE` or `ONMHJ_CODEX_EXECUTABLE` to override the selected executable.

Agent mode runs non-interactively in an isolated temporary directory. Claude Code disables customizations, tools, browser integration, and session persistence; Codex ignores user configuration and rules and uses a read-only sandbox with report-irrelevant tools disabled. Each native-agent or API model call has its own configurable 15-minute timeout; the full report job has no single wall-clock deadline.

Large raw inputs are split on complete JSONL records into session-preserving 20 KiB chunks, processed with concurrency three, and cached for retry. If validated map summaries exceed the 64 KiB final-input bound, they are merged in bounded intermediate batches before the final reducer call. Every supplied evidence ID must be covered by each validated intermediate summary chain. On POSIX-compatible filesystems, part-cache directories and files use modes `0700` and `0600`.

API mode is shared by both plugin runtimes and requires explicit configuration:

```sh
node /path/to/onmhj/bin/onmhj.js config \
  --report-auth=api \
  --report-api-base=https://example.com/v1 \
  --report-model=model-name \
  --report-api-key-env=ONMHJ_LLM_API_KEY
```

Config is stored at:

```txt
~/.config/onmhj/config.json
```

Events spool locally at:

```txt
~/.local/state/onmhj/events/YYYY-MM-DD.jsonl
```

Internal operational logs are stored separately and do not include prompt text:

```txt
~/.local/state/onmhj/internal/YYYY-MM-DD.jsonl
```

## Manual Injection

Inject one manual event into the local spool:

```sh
node /path/to/onmhj/bin/onmhj.js inject \
  --date=2026-07-08 \
  --cwd=/path/to/workspace/project-generator \
  --source=manual \
  --source-id=manual-2026-07-08-1 \
  --text="Work summary"
```

Bulk import normalized JSONL:

```sh
node /path/to/onmhj/bin/onmhj.js import /tmp/onmhj-backfill.jsonl
```

Scan local Codex and Claude transcripts after installation or update:

```sh
node /path/to/onmhj/bin/onmhj.js sessions
```

The first scan records per-file byte cursors under `~/.local/state/onmhj/session-ingest/`. Parser failures create metadata-only quarantine entries and block final-report confirmation for the affected date until the same command retries successfully. OpenAI-compatible clients or proxies can instead import JSONL records containing `provider`, `tsUtc`, `cwd`, `request`, and `response`.

Parser version 6 extracts public Markdown links, HTTP(S) URLs, and DOI values from final assistant answers into `AISessionTurn.references`. It excludes local files, localhost, private-network and local-only hosts, credentialed URLs, and URLs containing sensitive authentication query parameters. It does not inspect tool results or browsing history. Newly generated reports use numbered task sections, preserve the reference-to-turn provenance, and place supplied URLs only under the related task's `References` or `참고 자료` subsection. Existing legacy reports remain valid until explicitly regenerated.

Imported events go to `~/.local/state/onmhj/events/YYYY-MM-DD.jsonl`; run `flush YYYY-MM-DD` to write the report repo.

When importing git history, prefilter commits to the configured owner identity. Include only commits where author or committer matches the configured owner name or email. This prevents team repo history from being reported as the user's own work.

Each imported event gets the configured `deviceId` unless the JSONL already includes one.

## Privacy

`onmhj` stores complete canonical user prompts and final assistant answers after redacting common token, password, secret, API key, bearer token, and private-key patterns. Reasoning fields and tool arguments from compatible API captures are never persisted.

Reference capture stores normalized titles and public URLs only. Page bodies, local resources, browsing-tool history, URL credentials, and sensitive signed-query URLs are not persisted.

Redaction is a best-effort guard, not a full secret scanner. Do not include credentials in prompts.

When asking an agent to summarize or flush reports, include this instruction:

```txt
Before writing to the onmhj report repo, exclude or redact tokens, API keys, passwords, private keys, bearer credentials, cookies, and one-off secret values. Keep only the work reason, process, decisions, and results.
```

## Smoke Test

Run the isolated built-in verification first. It uses temporary config and report repositories without changing the active user config:

```sh
node /path/to/onmhj/bin/onmhj.js selftest
```

Run a short session in a target repo. For Codex:

```sh
codex exec --dangerously-bypass-hook-trust \
  -C /path/to/workspace/example-repo \
  "onmhj smoke test. Reply with the repo name and clean git status only."
```

For Claude Code, install or update the plugin, run `/reload-plugins` or start a new session in the target repo, then submit one short prompt. Use `/onmhj:onmhj status` to verify the namespaced command is available. Do not run this authenticated smoke against a production report repo if you do not want a report job scheduled.

Confirm events were captured:

```sh
node /path/to/onmhj/bin/onmhj.js status
tail -n 5 ~/.local/state/onmhj/events/$(date -u +%F).jsonl
tail -n 20 ~/.local/state/onmhj/internal/$(date -u +%F).jsonl
```

Flush to the report repo:

```sh
node /path/to/onmhj/bin/onmhj.js flush
```

Before writing, `flush` pulls the report repo with `git pull --rebase --autostash` when an upstream exists, merges the existing `raw/ai-sessions/YYYY-MM-DD.jsonl` with this device's local events, and dedupes them. This lets multiple computers append to the same report repo date without overwriting each other.

If you bypass `flush` with a custom backfill or direct report-repo edit, run the same pull first. Never generate from a stale checkout of the report repo.

Expected outputs after `flush`:

```txt
raw/ai-sessions/YYYY-MM-DD.jsonl
```

`ejmhj` and automatic report jobs also add:

```txt
reports/YYYY-MM-DD.md
```

`flush` publishes raw evidence only. `ejmhj` and automatic report jobs also generate the final report and confirm the work date. A missing or invalid final report is retried even when an older job says it completed. Commands commit and push unless `--no-push` is passed; `--no-push` never advances confirmation. Publication stops when the report repo already contains staged changes.

## Troubleshooting

If `codex plugin marketplace add` says the root has no supported manifest, check that `.agents/plugins/marketplace.json` exists.

If no events appear in Codex, open `/hooks`, trust the `onmhj` hooks, and start a new session. `SessionStart` only fires for new sessions.

If no events appear in Claude Code, confirm `onmhj@onmhj-local` is installed and enabled, run `/reload-plugins`, then start a new session. Use the namespaced commands `/onmhj:onmhj` and `/onmhj:ejmhj`.

If internal logs are empty too, the plugin hook is not running. Update or reinstall the selected platform's plugin, reload its hooks, then start a new session.

If the hook cannot find Node, install Node or make sure the selected plugin runtime can resolve `node` non-interactively.

If Windows Codex reports `SessionStart hook (failed)` or `UserPromptSubmit hook (failed)` with exit code 1 after install, check `.codex/hooks.json`. Version `0.1.10` had POSIX-only hook commands, which PowerShell parsed as invalid syntax. Version `0.1.11` adds `commandWindows` entries for Codex on Windows. Reinstall with `codex plugin add onmhj@onmhj-local`, then start a new session.

If Claude report generation reports an unknown `--safe-mode` option, run `claude --version`. Update to Claude Code 2.1.169 or newer with `claude update`, then retry.

If Claude report generation says the native agent failed, run `claude auth status` and confirm the selected `claude` executable resolves in the non-interactive environment. Set `ONMHJ_CLAUDE_EXECUTABLE` when the binary is installed at a nonstandard path, then retry the pending job from a Claude Code session.

## Claude Code

The Claude Code plugin manifest lives at:

```txt
.claude-plugin/plugin.json
```
