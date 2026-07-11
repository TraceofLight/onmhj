# Changelog

## 0.1.12 - 2026-07-12

- Added automatic final reports at `reports/YYYY-MM-DD.md` through local Codex auth or an OpenAI-compatible API.
- Separated deterministic `daily` evidence from validated final `reports` output.
- Confirmed dates only after report generation and git publication succeed.
- Requeued missing or invalid reports, including storage-only dates without a local event spool.
- Made `ejmhj` run the same full report pipeline as background jobs.

## 0.1.11 - 2026-07-09

- Fixed Codex lifecycle hooks on Windows by adding PowerShell `commandWindows` entries for `SessionStart` and `UserPromptSubmit`.
- Documented the `0.1.10` Windows install failure mode: POSIX-only hook commands caused PowerShell parse errors and `hook exited with code 1`.
- Added a Node test that verifies Codex hook commands define and run their Windows command variants.

## 0.1.10 - 2026-07-09

- Initial local plugin build for AI-session worklog capture, local event spooling, and git-backed daily reporting.
