# Lossless AI Session Capture Design

## Goal

Prevent work evidence from disappearing because of arbitrary prompt or answer preview limits.

## Capture Contract

- Every captured session stores the complete redacted canonical user prompt and final assistant response.
- `promptMode` and its `preview`, `full`, and `off` values are removed.
- Existing configurations containing `promptMode` remain readable, but the obsolete value is ignored so upgraded devices always capture complete turns.

The transcript parser continues to exclude reasoning and tool arguments. Secret redaction remains mandatory before persistence.

## Compatibility

CLI help no longer exposes prompt capture modes. New `--prompt` configuration requests fail as unknown arguments. Existing configuration files remain readable because obsolete `promptMode` values are ignored.

Historical preview records remain unchanged until their source transcripts are replayed. Recollection creates canonical full `AISessionTurn` records and supersedes legacy prompt-only records through the existing stable `sourceId` merge.

## Verification

- Legacy `preview` and `off` configurations both capture complete turns.
- Hook capture stores a prompt longer than 300 characters without truncation.
- Transcript ingestion stores prompts and final answers longer than 300 characters without truncation.
- CLI help and configuration no longer expose `promptMode`.
- Existing parser, ingestion, report, and plugin tests remain green.
