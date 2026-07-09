# Changelog

## 0.1.11 - 2026-07-09

- Fixed Codex lifecycle hooks on Windows by adding PowerShell `commandWindows` entries for `SessionStart` and `UserPromptSubmit`.
- Documented the `0.1.10` Windows install failure mode: POSIX-only hook commands caused PowerShell parse errors and `hook exited with code 1`.
- Added a Node test that verifies Codex hook commands define and run their Windows command variants.

## 0.1.10 - 2026-07-09

- Initial local plugin build for AI-session worklog capture, local event spooling, and git-backed daily reporting.
