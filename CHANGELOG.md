# Changelog

## Unreleased

- Added deterministic Codex, Claude, and OpenAI-compatible session-turn normalization with final assistant evidence.
- Added incremental transcript cursors, metadata-only quarantine, retry, and affected-date confirmation blocking.
- Skipped known Codex internal/context-only and empty no-op turns, and replayed stale file cursors after parser upgrades.
- Prevented final-report regeneration from removing prior report content.
- Hid Windows worker, report-agent, and git subprocess windows during background report generation.
- Added an `autoReport` gate and one-commit raw-only multi-date session publishing.

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
