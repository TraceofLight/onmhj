# Changelog

## 0.1.20 - 2026-11-28

- Recovered human prompts stored only in Codex `item_completed.UserMessage` records, including image-only requests, while keeping canonical user messages authoritative.
- Bumped the session parser to version 13 so upgrading replays older cursors and clears successfully recovered quarantine entries, including compressed rollouts.

## 0.1.19 - 2026-11-25

- Ran `/ejmhj` through `bin/onmhj-node` like `/onmhj`, so it no longer fails when `node` is not on `PATH`.
- Split `bin/onmhj.js` into responsibility modules under `bin/cli/`; the entry path, exports, outputs, and behavior are unchanged.
- Rewrote the README around what the plugin does and moved implementation details to `docs/internals.md` (Korean: `docs/internals.ko.md`); the Korean README now uses a polite formal style.

## 0.1.18 - 2026-11-25

- Escaped `~` as `\~` in every validated report (outside code and URLs) so range marks such as `1~2` no longer render as GitHub strikethrough; the prior-report preservation check compares escaped lines.

## 0.1.17 - 2026-11-24

- Added `--report-pipeline=facts`, an opt-in fact-first pipeline for smaller local models (default stays `summary`): per-chunk fact extraction with kind, epistemic status, importance, and exact values, chained per session; goal planning with five voted turn assignments; model-decided reassignment of off-topic facts; one-call review that also drops superseded facts; cited task writing sized to the work actually done; kind-based section placement; line-level verification; and one grounded summary sentence per task. On the test days it reached Claude-level scores on a local Qwen model; with Claude it costs 2.5-3.7x the tokens without a quality gain, so keep `summary` for Claude and Codex.
- Added `--report-api-light-effort` to run short judgments (review, verification, polishing, summary sentences) at a lighter reasoning effort; extraction, grouping, reassignment, and writing keep `--report-api-effort`. On Basalt, `none` disables thinking for those steps.
- Cached fact extraction per chunk and added `--report-prefetch` to extract today's facts on every `catchup`.
- Logged per-stage call counts and timing in `report_facts`, and `report_revise_ignored` when `--report-revise` is set with the fact pipeline.
- Added `--report-api-key-file` so API mode can read its key from a file when the environment variable is absent, as in scheduled `catchup` runs.
- Added `--report-api-effort` to send `reasoning_effort` with API report requests.
- Streamed API report responses so long reasoning no longer hits proxy idle timeouts such as Cloudflare 524.
- Added `--report-segment-agent`: a model plans topic boundaries for sessions larger than one chunk from a compact turn index; code validates the plan, splits oversized segments by bytes, caches it per session, and falls back to byte packing.
- Added `--report-revise` for the summary pipeline: each validated task is rewritten from its source turns (including later turns of the same sessions) with checks for values missing from the evidence, untranslated English phrases, glued hashes, and foreign scripts; a broken revision keeps the validated draft.
- Split the fact pipeline into stage modules under `bin/report-facts/` with shared helpers in `bin/report-util.js`.

## 0.1.16 - 2026-11-17

- Captured DeepSeek Harness (DSH) sessions from `$DSH_HOME/sessions` as `dsh` turns, skipping subagent sessions and parent history copied into forked sessions, and extending the last human turn with answers from prompt-less continuation turns.
- Decoded multi-frame zstd transcripts frame by frame, because Node's zstd stream stops after the first frame, and left a frame that is still being appended for the next scan.
- Added `onmhj catchup` to scan transcripts and run due report jobs without a lifecycle hook, and `onmhj schedule install|uninstall|status` to run it hourly through launchd, a systemd user timer, or Windows Task Scheduler.

## 0.1.15 - 2026-10-19

- Dropped stale cursors of vanished transcripts. Cursors at the current parser version and quarantined ones are kept, because publish scopes and moved-quarantine recovery still read them.
- Read human prompts from legacy Codex rollouts (CLI before 0.142.3) that store them only as metadata-less user messages.
- Discovered compressed `.jsonl.zst` and `archived_sessions` Codex rollouts, followed known rollouts when Codex moves them, and skipped unchanged compressed files.
- Kept completed turns when a truncated copy of the same turn arrives as pending.
- Asked intermediate reductions for 60% of each size limit and accepted outputs that overshoot the limit but still shrink their input, because the model tracks byte budgets only loosely.
- Checked intermediate output size after evidence and reference validation so other violations are still retried.
- Gave each intermediate reduction group an equal share of the target so reduction converges even when the model compresses only to the requested budget.
- Failed fast when evidence IDs alone exceed the reduction target and bounded reduction rounds.
- Recorded Codex cross-thread delegation turns with the delegated input as the prompt.
- Linked prompt-less Codex retries after an errored turn to the original human turn.
- Replayed quarantined Codex transcripts from their `.jsonl.zst` or `archived_sessions` successor once per file change.
- Reported remaining quarantine entries as `sessions` failures.
- Limited Codex parser replay replacement to the turns a transcript emits again, so spawned threads that share a session id no longer erase turns recorded from other threads.
- Bounded final report reduction with validated intermediate summaries when map output exceeds the final-input limit.
- Preserved every evidence ID through intermediate reduction and rejected oversized intermediate output.
- Prevented live long-running workers from being replaced solely because their lock timestamp is older than six hours.
- Pinned agent reports to Claude `sonnet` or Codex `gpt-5.6-terra` with medium effort by default, added model and timeout overrides, and increased the per-call timeout to 15 minutes.
- Preserved explicit timeout errors instead of replacing them with generic native-agent output.
- Reduced intermediate agent input to 64 KiB and accepted a single outer JSON fence for reliable schema validation.
- Added one validation-guided retry for intermittent malformed map-summary output.
- Re-compressed oversized atomic summaries instead of failing before a reduction attempt.
- Enforced a shrinking byte limit on each intermediate summary and fed violations back into retries.

## 0.1.14 - 2026-07-15

- Added deterministic Codex, Claude, and OpenAI-compatible session-turn normalization with final assistant evidence.
- Added incremental transcript cursors, metadata-only quarantine, retry, and affected-date confirmation blocking.
- Skipped known Codex internal/context-only, compaction-only, and empty no-op turns, and replayed stale file cursors after parser upgrades.
- Prevented final-report regeneration from removing prior report content.
- Hid Windows worker, report-agent, and git subprocess windows during background report generation.
- Added an `autoReport` gate and one-commit raw-only multi-date session publishing.
- Removed deterministic daily artifacts so raw JSONL is the only report evidence source.
- Added session-preserving 20 KiB map generation with bounded concurrency, resumable part caching, and one final reducer call.
- Retried transient invalid map output once without discarding valid parts.
- Rejected map references not present in the corresponding raw evidence chunk.
- Required map summaries to cover every supplied evidence record and hardened malformed raw handling.
- Redacted credential-like values from report backend failure details.
- Restricted resumable report-part files to the current user.
- Kept report repositories unchanged when generation or validation fails before publication.
- Added an explicit Codex or Claude report-agent override while preserving runtime-native selection by default.

## 0.1.13 - 2026-07-12

- Added final report generation through the active local Claude Code login.
- Added Claude-native lifecycle hooks and runtime-native agent selection while preserving Codex and shared API behavior.
- Refreshed plugin packages and parity documentation, including namespaced Claude commands and ordered retries.

## 0.1.12 - 2026-07-12

- Added automatic final reports at `reports/YYYY-MM-DD.md` through local Codex auth or an OpenAI-compatible API.
- Separated deterministic `daily` evidence from validated final `reports` output.
- Confirmed dates only after report generation and git publication succeed.
- Requeued missing or invalid reports, including storage-only dates without a local event spool.
- Made `ejmhj` run the same full report pipeline as background jobs.
- Simplified the Korean final report title to `# YYYY-MM-DD 뭐 했지`.

## 0.1.11 - 2026-07-09

- Fixed Codex lifecycle hooks on Windows by adding PowerShell `commandWindows` entries for `SessionStart` and `UserPromptSubmit`.
- Documented the `0.1.10` Windows install failure mode: POSIX-only hook commands caused PowerShell parse errors and `hook exited with code 1`.
- Added a Node test that verifies Codex hook commands define and run their Windows command variants.

## 0.1.10 - 2026-07-09

- Initial local plugin build for AI-session worklog capture, local event spooling, and git-backed daily reporting.
