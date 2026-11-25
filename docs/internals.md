# Internals

Implementation details behind the [README](../README.md) ([한국어](./internals.ko.md)). For setup and configuration, see [installation.md](./installation.md).

## Capture and publishing

- Local-first hooks: session events append to local JSONL, not directly to git.
- Git-backed history: `flush` writes canonical raw JSONL into a separate report repo.
- `flush` and worker report jobs pull the report repo with `git pull --rebase --autostash` before writing. If you edit the report repo directly or run a custom backfill script outside `onmhj flush`, pull the report repo first, then merge/dedupe existing raw events instead of overwriting them.

## Report generation

- Automatic final reports: report jobs turn raw evidence into `reports/YYYY-MM-DD.md` through the plugin runtime's local Claude Code or Codex login, or an OpenAI-compatible API (key from an env var or `--report-api-key-file`).
- Chunked generation: large workdays are split into session-preserving 20 KiB chunks, summarized by up to three isolated agents, then hierarchically reduced within a bounded final input.
- Fact-first pipeline: `--report-pipeline=facts` is an opt-in alternative for smaller local models (default `summary`), and `--report-segment-agent` and `--report-revise` add optional quality passes. See [Installation](./installation.md#configure-report-repo).
- Agent auth by default: `report-agent=auto` uses the active plugin runtime's local login; set `codex` or `claude` to override it. API mode is shared.
- Native executable override: set `ONMHJ_CLAUDE_EXECUTABLE` or `ONMHJ_CODEX_EXECUTABLE` for a nonstandard installation path.

See [Safety](#safety) for timeout, validation, and retry rules.

## Multi-device and catch-up

- Multi-device safe: each computer has a `deviceId`; existing raw logs are pulled, merged, and deduped.
- Automatic catch-up: background jobs retry every unconfirmed report date until `confirmedThrough` advances.
- `confirmedThrough` advances only in date order for each device. If an earlier report is waiting for retry, later jobs stay pending. A slower device catches up from its own local events; its older watermark does not regenerate another device's already valid final reports.

## Confirmation

A date is confirmed only after its final report passes validation and raw, report, and device confirmation are committed successfully. Completed jobs with a missing or invalid report are queued again automatically.

`ejmhj --no-push` generates and commits raw evidence plus the final report without writing confirmation. `flush --no-push` generates and commits raw evidence only. Normal `ejmhj` uses the ordered job queue, so a later date cannot bypass an earlier retry and confirmation never moves backward.

## Backfill

Manual event:

```sh
node bin/onmhj.js inject \
  --date=2026-07-08 \
  --cwd=/path/to/repo \
  --source=manual \
  --source-id=manual-2026-07-08-1 \
  --text="Work summary"
```

Bulk import:

```sh
node bin/onmhj.js import /tmp/onmhj-backfill.jsonl
```

An OpenAI-compatible capture record contains `provider`, `tsUtc`, `cwd`, and the complete `request` and `response` objects. The importer retains the canonical user message, final assistant content, model, and tool names. Provider reasoning fields and tool arguments are validated but not stored.

Git-history backfills must include only commits authored or committed by the configured owner identity.

Custom backfill jobs must start from the latest report repo state. Run `git pull --rebase --autostash` in the report repo before writing `raw/`, `reports/`, or `state/`.

## Canonical sessions

`onmhj sessions` reads Codex, Claude, and DSH transcripts incrementally. Each canonical `AISessionTurn` contains a real user request and its final answer when available; known tool results, skill injections, notifications, commands, and compaction records remain only in the original transcript. Canonical user prompts and final answers are stored completely after redaction.

Public links and DOI values cited in final assistant answers are stored in raw evidence and carried into final reports. Public Markdown links, bare HTTP(S) URLs, and DOI values cited in a final assistant answer are normalized into the turn's `references` array. Local files, localhost, private-network addresses, local-only hostnames, credentialed URLs, and URLs with sensitive authentication query parameters are excluded. Tracking parameters and fragments are removed. New final reports group work into numbered tasks with background, process, decisions, and results; each reference appears only in the related task's `References` or `참고 자료` subsection. Tool records and browsing history are not scanned.

DSH has no lifecycle hooks, so its sessions under `$DSH_HOME/sessions` (default `~/.dsh/sessions`) are captured only by a scan. Run `onmhj schedule install` once from a stable checkout to scan and schedule reports hourly; see [Installation](./installation.md#dsh). DSH subagent sessions and the parent history copied into a forked session are skipped, and a prompt-less turn that resumes after subagent results extends the last human turn.

Set `onmhj config --auto-report=false` to stop `SessionStart` from scheduling report jobs. `onmhj sessions --publish` then pulls the registered repo, blocks on any unresolved quarantine entry, replaces successfully replayed current-device session scopes in `raw/ai-sessions`, and creates one commit and push without changing `reports/`, report jobs, or confirmations. Other devices, sessions, and event types are preserved.

File cursors live under `~/.local/state/onmhj/session-ingest/`. A parser-version replay replaces prior canonical output only after that transcript parses successfully. A malformed relevant record stops at its byte offset and creates a metadata-only quarantine entry; an unsuccessful replay keeps the previous canonical set and remains replayable from the start.

## Storage

Local machine:

- config: `~/.config/onmhj/config.json`
- events: `~/.local/state/onmhj/events/YYYY-MM-DD.jsonl`
- internal logs: `~/.local/state/onmhj/internal/YYYY-MM-DD.jsonl`
- report jobs: `~/.local/state/onmhj/jobs/reports/YYYY-MM-DD.json`
- resumable report parts: `~/.local/state/onmhj/report-parts/YYYY-MM-DD/INPUT_HASH/`
- local confirmed watermark: `~/.local/state/onmhj/jobs/reports/confirmed.json`
- worker log: `~/.local/state/onmhj/worker.log`
- transcript cursors and quarantine: `~/.local/state/onmhj/session-ingest/`

Report repo:

- raw events: `raw/ai-sessions/YYYY-MM-DD.jsonl`
- final report: `reports/YYYY-MM-DD.md`
- device confirmations: `state/devices/DEVICE_ID.json`

## Safety

- Hooks append locally only.
- Git sync and push run only during `sessions --publish`, `flush`, or worker-driven report jobs.
- `flush`/worker pulls before writing; direct report-repo edits and custom backfills must do the same manually.
- Canonical prompts and final answers are captured completely; reasoning and tool arguments are not persisted.
- Reference capture uses only public URLs cited in final assistant answers; it does not retain page bodies, local resources, or browsing-tool history.
- Full report generation writes new raw, report, and confirmation artifacts only after generation and validation succeed. Regeneration must also preserve every prior non-heading report line; rejected output leaves all three artifacts unchanged.
- Prompt/report inputs, generated output, and backend failure details get best-effort redaction for token, password, bearer credential, private-key, and API-key-like patterns.
- Native agent reports run non-interactively in an isolated temporary directory. Codex ignores user configuration and rules and runs in a read-only sandbox with report-irrelevant tools disabled. Claude Code runs in safe mode with customizations, tools, browser integration, and session persistence disabled. Evidence is treated as untrusted data.
- Every model call has its own configurable 15-minute timeout; the full report job has no single wall-clock deadline.
- Chunked report generation never splits a JSONL record or AI turn. A map summary must cover every supplied evidence ID; an invalid part is retried up to twice with validation feedback, while valid parts are reused from cache.
- On POSIX-compatible filesystems, resumable report-part directories and files are restricted to the current user with modes `0700` and `0600`.
- Automatic publication refuses to run when the report repository already has staged changes and uses a repository-wide publication lock.
- Local report dates use the configured timezone; event spool filenames use UTC.

## Development

Run the tests from the repo root:

```sh
node --test tests/*.test.js
```

Pass the test files with the glob; passing the `tests/` directory does not work. `bin/onmhj-node` runs `node` with the same arguments when `node` is not on `PATH`: it tries `node`, then `mise exec -- node`, then the Node bundled with the ChatGPT app, and exits 127 if none is found.

```sh
bin/onmhj-node --test tests/*.test.js
```
