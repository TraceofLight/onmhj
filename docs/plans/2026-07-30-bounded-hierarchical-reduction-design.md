# Bounded Hierarchical Reduction Design

## Goal

Generate a final report from unusually large workdays without sending an unbounded set of map summaries to one Claude, Codex, or API request.

## Preservation Contract

- `raw/ai-sessions/YYYY-MM-DD.jsonl` remains complete, canonical, and byte-preserving evidence.
- Every map and intermediate summary must retain every supplied evidence ID.
- Every reference remains tied to supplied evidence IDs and is revalidated in the final report.
- The final Markdown is a concise interpretation of raw evidence, not a lossless duplicate of every prompt and answer. The raw artifact is the source for complete detail and later regeneration.

## Flow

```text
raw evidence
  -> bounded map summaries
  -> deterministic byte-bounded batches
  -> validated intermediate summaries (only when needed)
  -> final report reducer
```

The runtime serializes map summaries and measures UTF-8 bytes. When they exceed 96 KiB, it groups adjacent summaries into batches no larger than that target and asks the same configured backend to merge each batch into one validated map-summary object. Each intermediate response is capped at 16 KiB. Repeat until the final reducer input is within the 96 KiB target.

No user setting is added. Claude, Codex, and API backends share this path.

## Failure Rules

- Invalid or oversized intermediate output fails the job before report publication.
- A job never advances confirmation unless final report validation succeeds.
- Existing map cache remains available after intermediate or final reduction failure.
- If one map summary alone exceeds the intermediate input target, fail explicitly rather than loop or silently discard content.

## Worker Lock Rule

Long-running workers own `worker.lock` while their PID exists. A six-hour timestamp is only stale for legacy lock files without a PID. A worker that loses ownership exits without releasing another worker's lock.

## Verification

- Test intermediate reduction retains every input evidence ID.
- Test final reducer prompt remains bounded after large map outputs.
- Test only a lock-owning worker can remove its lock.
