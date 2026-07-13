# AI Session Parser Reconciliation Design

## Goal

Store only real human requests and their AI final responses as canonical `AISessionTurn` events, while keeping complete prompts and answers and preserving the original transcripts as the replay source.

## Confirmed policy

- Original Codex and Claude transcripts remain unchanged and are the audit/reparse source.
- Canonical `AISessionTurn` contains a real user request, plus the final assistant response when one exists.
- Tool results, skill injections, task notifications, slash-command envelopes, compaction messages, and other protocol records are not report evidence and do not become separate normalized events.
- Known internal records are ignored without replacing an active human turn.
- Unknown user-shaped records fail closed: ingestion stops at that offset and writes metadata-only quarantine information.
- AI analysis may help investigate a quarantine later, but it is not part of normal deterministic parsing.

## Parser behavior

### Claude

Classify a `user` record before opening a turn.

1. Prefer structural metadata: `isMeta`, `sourceToolUseID`, tool-result blocks, and attachment/task-notification records.
2. For older transcript shapes without reliable metadata, recognize only exact known protocol markers such as `<task-notification>`, `Base directory for this skill:`, `<command-name>`, `<local-command`, compaction continuation text, malformed-tool feedback, and interruption notices.
3. Ignore ordinary internal records while preserving the active human turn.
4. Treat command envelopes as turn boundaries so an earlier unfinished task cannot absorb a later assistant response.
5. Quarantine any remaining user-shaped content that cannot be classified safely.

### Codex

Keep the existing task/user/final-answer mapping. If `task_complete` explicitly contains an empty final answer, emit the prompt as `pending` without `assistantResponse`. Do not label an answerless turn `complete`.

## Authoritative replay and stale-event removal

Increasing the parser version currently rereads transcripts but only upserts emitted `sourceId` values. Events that a newer parser intentionally stops emitting therefore survive both the local event spool and the Git raw merge.

Each successfully replayed transcript will instead be authoritative for its `(deviceId, provider, sessionId)` scope:

1. Parse the file from offset zero without destructively changing existing canonical events.
2. If parsing fails, retain the previous canonical set, keep the migration cursor replayable, and block publication through quarantine.
3. If parsing succeeds, replace local transcript-derived `AISessionTurn` events in that scope with the newly parsed set.
4. Persist the reconciled session scope in cursor metadata.
5. During `sessions --publish`, remove stored raw events only for reconciled scopes owned by the current device, then merge the current local canonical set.

This preserves other devices, manual imports, Git events, and unrelated sessions. It also removes historical synthetic turns even when the new parser emits no replacement for their old `sourceId` values.

## Verification

- Fixture tests prove every known Claude internal shape is excluded and cannot overwrite a real turn.
- Unknown Claude user shapes still quarantine.
- Codex empty completion remains pending.
- A parser-version replay removes stale local synthetic turns.
- Raw publication removes stale events only from the current device's reconciled session scope and preserves all other data.
- Full Node tests, syntax checks, selftest, and diff checks pass before plugin refresh and reinstall.
