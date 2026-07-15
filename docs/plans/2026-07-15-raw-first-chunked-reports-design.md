# Raw-First Chunked Reports Design

## Goal

Reduce the worklog pipeline to two durable user-facing artifacts:

```text
normalized events -> raw/ai-sessions/YYYY-MM-DD.jsonl
                  -> reports/YYYY-MM-DD.md
```

`raw` is the canonical evidence and `report` is the final document the user reads. Remove `daily` from report generation and from the current storage contract.

Large raw inputs use bounded, application-orchestrated subagents. The application splits evidence without cutting a JSONL record or AI turn, summarizes chunks independently, and reduces those summaries into one validated final report.

## Non-Goals

- Do not change the normalized raw event schema.
- Do not enable model-controlled tools, hooks, or native multi-agent orchestration.
- Do not pin a different model or effort level for reports.
- Do not change the final Markdown contract, reference validation, ordered retries, or confirmation rules.
- Do not add user-facing chunk-size or concurrency configuration in the first implementation.

## Storage Contract

- `raw/ai-sessions/YYYY-MM-DD.jsonl`: merged and deduplicated source of truth.
- `reports/YYYY-MM-DD.md`: validated final report for the work date.
- `state/devices/DEVICE_ID.json`: device confirmation watermark.
- Local report-part cache under `cfg.stateDir`: incomplete map results used only for retry recovery.

Stop creating `daily/YYYY-MM-DD.md`. Existing `daily/` history is ignored by upgraded code and removed from the report repository in one explicit migration commit. The runtime must not automatically delete historical daily files because a background report job should not produce a repository-wide destructive change.

`flush [date]` remains useful for imported and manually injected events, but publishes merged raw evidence only. `sessions --publish` keeps its current raw-only multi-date behavior.

## Report Flow

```text
local and stored events
        |
        v
merge and write canonical raw
        |
        v
split raw into semantic chunks
        |
        +--> map subagent 1 --+
        +--> map subagent 2 --+--> reduce summaries --> final report
        +--> map subagent N --+
                                      |
                                      v
                         validate, commit, confirm
```

When the raw evidence fits in one chunk, skip the map stage and generate the final report directly. This preserves the existing short path for small workdays.

The Node process owns splitting, concurrency, caching, and reduction. A "subagent" is one isolated `claude -p`, `codex exec`, or API request for a supplied chunk. The child model does not receive multi-agent or filesystem tools.

## Semantic Chunking

### Input units

Parse raw JSONL before chunking. Each valid JSONL record is an atomic evidence line. Use `sourceId` as its evidence identifier; when absent, derive a stable identifier from the SHA-256 hash of the canonical line.

Group records by `(deviceId, provider, sessionId)` and order each session by `tsUtc`. Order session groups by their first event timestamp. This keeps a conversation together while retaining a deterministic workday order.

### Size policy

- Target size: `20 * 1024` UTF-8 bytes, measured with `Buffer.byteLength` including separators.
- Keep a session in one chunk when it fits.
- Pack adjacent complete sessions into the current chunk while the target still fits.
- When one session exceeds the target, split it only between JSONL records.
- Never substring a raw JSONL line, prompt, or assistant response.
- When one atomic line itself exceeds 20 KiB, emit it as one oversize chunk. The target is soft because evidence integrity is more important than an exact byte ceiling.

This policy means one `AISessionTurn` always keeps its prompt and final assistant response together. Field-aware splitting of a single oversized turn is deferred until real data proves that oversize atomic records are a recurring problem.

### Measured example

The observed 2026-07-14 report prompt was about 404 KiB because it contained daily Markdown, raw JSONL, reference provenance, and instructions. Removing daily leaves 240,800 bytes of raw JSONL across 136 records.

Applying the implemented session-first 20 KiB packing to that raw file produces 15 chunks. The largest chunk is 20,115 bytes and no atomic record exceeds the target. This is the expected common large-day path: several bounded calls without cutting any turn.

Each chunk receives deterministic metadata:

```json
{
  "schemaVersion": 1,
  "date": "YYYY-MM-DD",
  "chunkId": "sha256:...",
  "index": 0,
  "count": 21,
  "sessions": ["provider:session-id"],
  "evidence": ["source-id-1", "source-id-2"]
}
```

## Map Subagents

Each map subagent receives:

- the work date and language;
- one chunk's metadata and raw JSONL records;
- the untrusted-evidence rule;
- a strict JSON output contract.

Map output is structured evidence, not Markdown:

```json
{
  "schemaVersion": 1,
  "chunkId": "sha256:...",
  "tasks": [
    {
      "title": "short task title",
      "background": ["confirmed fact"],
      "process": ["confirmed action"],
      "decisions": ["confirmed decision"],
      "results": ["confirmed result"],
      "followUps": ["confirmed remaining work"],
      "evidenceIds": ["source-id-1"],
      "references": [
        {"url": "https://example.com", "title": "optional", "evidenceIds": ["source-id-1"]}
      ]
    }
  ]
}
```

Require every factual item and reference to retain at least one evidence identifier. Reject invalid JSON, a mismatched chunk ID, unknown evidence IDs, or malformed task arrays.

Run at most three map subagents concurrently. Replace the synchronous native runner with a small asynchronous `child_process.spawn` wrapper so native and API backends share bounded concurrency without adding a dependency.

The existing 10-minute backend timeout applies to each subagent, not to the whole report job. A large report may therefore run longer than ten minutes overall, while no individual child can hang forever.

## Retry Cache

Without a part cache, one failed chunk would discard every successful model call and the ordered job retry would regenerate the entire workday. Store successful validated map output under:

```text
STATE/report-parts/YYYY-MM-DD/INPUT_HASH/
  manifest.json
  part-000.json
  part-001.json
```

`INPUT_HASH` covers raw content, report language, map prompt version, and chunking version. A raw change or prompt-contract change automatically selects a new cache directory.

On retry:

1. Recompute the manifest and input hash.
2. Reuse only part files whose chunk ID and schema validate.
3. Run subagents only for missing or invalid parts.
4. Keep map parts when final reduction or publication fails.
5. Remove the date's part cache only after report publication and local confirmation succeed.

A truncated or malformed cache file is treated as missing and regenerated.

## Reduction

The reducer receives validated map JSON, not raw evidence or daily Markdown. It merges tasks that describe the same work across sessions and produces the existing final Markdown contract.

Deterministically extract the complete reference provenance from raw and include that compact list in the final reduction. This preserves the existing rule that every collected reference appears under its related task without sending the full raw input again.

Include `previousReport` only in the final reduction so regeneration can preserve all prior non-heading lines. Keep the existing final report and reference validators unchanged.

If the combined map output exceeds 40 KiB, group map results on JSON record boundaries and run an intermediate reduction round using the same structured task contract. Repeat until the final reducer input is at most 40 KiB. This keeps each Claude reduction comfortably below the observed 10-minute child limit while preserving a bounded reduction tree for unusually large workdays.

## Failure Semantics

- Raw parsing failure stops before any subagent call.
- A map timeout or invalid map result fails the report attempt but preserves valid cached parts.
- A reduction timeout or invalid final report reuses all map parts on retry.
- No final report or device confirmation is written until the final validator passes.
- Ordered date processing and retry backoff remain unchanged.
- A changed raw input invalidates prior parts through the input hash.

## Code Changes

### `bin/onmhj.js`

- Replace `prepareDaily` with raw-only artifact preparation.
- Remove deterministic daily rendering helpers and `dailyTarget` publication.
- Change report generation signatures from `(cfg, date, daily, raw, deps)` to `(cfg, date, raw, deps)`.
- Replace `buildReportPrompt` with direct, map, intermediate-reduce, and final-reduce prompt builders.
- Add deterministic JSONL session chunking and map-result validation.
- Add bounded asynchronous backend execution and local part caching.
- Commit raw, report, and confirmation only.
- Update self-test and exports.

### Tests

- Update report and publication tests to assert no daily artifact is created or staged.
- Prove raw-only `flush` preserves multi-device merge behavior.
- Prove UTF-8 byte accounting and exact 20 KiB boundaries.
- Prove complete sessions remain together when they fit.
- Prove large sessions split only between JSONL records.
- Prove one oversized record remains intact in an oversize chunk.
- Prove at most three subagents run concurrently.
- Prove successful parts are reused after one part fails.
- Prove raw or prompt-version changes invalidate cached parts.
- Prove oversized map output uses an intermediate reduction round.
- Prove final validation, reference completeness, prior-content preservation, ordered retries, and confirmation ordering remain unchanged.

Use injected agent runners in tests; do not make authenticated model calls in the automated suite.

### Documentation and packaging

- Update README, Korean README, installation guide, commands, changelog, and workflow diagrams from raw/daily/report to raw/report.
- Remove `daily` from active storage and completion contracts.
- Refresh and reinstall both plugin packages only after the source test suite passes.

## Migration

1. Stop the active report worker or let the current job finish so the report repository is clean.
2. Deploy code that no longer reads or writes `daily/`.
3. Run the full source test suite and plugin self-test.
4. Refresh and reinstall the local plugins.
5. In the report repository, delete tracked `daily/` in one explicit migration commit.
6. Retry pending report dates. Existing valid reports and raw evidence remain unchanged.

No backfill is required. A future report regeneration reads canonical raw evidence and ignores historical daily files.

## Success Criteria

- New publication produces no `daily` file or staged daily change.
- `raw` remains the only persisted source of report facts.
- A 404 KiB raw day is split into deterministic approximately 20 KiB semantic chunks without cutting a turn.
- Map work runs with concurrency at most three and resumes from valid cached parts.
- The final report passes the existing structure, reference, and prior-content validators.
- A failed subagent cannot advance confirmation or lose successful part work.
- Small workdays still use one direct report call.
