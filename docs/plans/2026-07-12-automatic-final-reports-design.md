# Automatic Final Reports Design

## Goal

Complete the automatic worklog pipeline:

```text
local events -> raw/ai-sessions/YYYY-MM-DD.jsonl
             -> daily/YYYY-MM-DD.md
             -> reports/YYYY-MM-DD.md
```

A date is complete only after its final report exists and passes validation.

## Storage Contract

- `raw/ai-sessions/YYYY-MM-DD.jsonl`: merged, deduplicated source events.
- `daily/YYYY-MM-DD.md`: deterministic evidence log grouped by device and repository.
- `reports/YYYY-MM-DD.md`: final report for the same work date.
- `state/devices/DEVICE_ID.json`: internal completion watermark. No user-facing ACK command.

The report filename always uses the work date, not the generation date.

## Automatic Flow

On `SessionStart`, scan eligible work dates through yesterday. Use both local event dates and dates already present in the registered report repository. Queue a date when any required artifact is missing, including dates previously marked completed without a report.

For each date, in order:

1. Pull the report repository.
2. Merge local and stored raw events.
3. Regenerate the deterministic daily log.
4. Generate the final report through the configured report backend.
5. Validate the report heading and required sections.
6. Commit and push raw, daily, report, and device confirmation together.
7. Advance local confirmation only after the git operation succeeds.

Failure at any step leaves the date incomplete. Existing ordered retry behavior handles later attempts and prevents later dates from advancing first.

## Report Backends

### Agent backend

`reportAuth=agent` runs the installed Codex CLI non-interactively and reuses local Codex authentication. The prompt supplies the work date, deterministic daily log, and normalized raw evidence. The model writes only the required Markdown report to stdout.

### API backend

`reportAuth=api` calls the configured OpenAI-compatible chat-completions endpoint with `reportApiBaseUrl`, `reportApiModel`, and the API key named by `reportApiKeyEnv`.

Both backends use the same prompt and validation contract. Secrets and credential-like values are redacted before model input.

## Report Contract

```md
# YYYY-MM-DD 어제 뭐 했지

## 요약
## 작업 이유
## 작업 과정
## 결정 사항
## 도출 결과
## 남은 일
```

The report summarizes only available evidence. It must not invent completed work. Empty categories state that no confirmed item was found.

## Commands

- `flush [date]`: refresh raw and daily only. It does not mark the date complete.
- `ejmhj [date]`: run the full raw/daily/report pipeline for yesterday or the specified work date.
- `worker`: run the same full pipeline for queued dates.

No ACK command is added.

## Recovery and Compatibility

- A completed job with a missing or invalid report is requeued automatically.
- Existing historical reports remain untouched unless their date is explicitly processed or found incomplete.
- Historical duplicate `daily` and `reports` files are not bulk-migrated in this change.
- The existing ordered retry and multi-device merge behavior remains.

## Verification

- Unit tests for report validation, agent execution, API execution, scheduling, and completion ordering.
- Integration test proving a missing report requeues a previously completed date.
- Self-test proving raw, daily, and report artifacts are produced before confirmation.
- Full Node test suite and syntax checks.
- Plugin reinstall followed by a fresh Codex session smoke test.
