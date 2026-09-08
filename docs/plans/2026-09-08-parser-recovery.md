# Transcript recovery implementation plan

Goal: recover interrupted human turns and skip verified heartbeat triggers without hiding unknown missing-user errors; ingest Windows path aliases once.

Architecture: keep an unfinished human turn as a fallback across task starts, consume it only when no new human prompt arrives, and retain its canonical identity. Recognize heartbeat only through the observed Codex automation tool envelope. Normalize Windows namespaced paths at ingestion boundaries and retire old cursor/quarantine aliases only after successful parsing.

Tech stack: CommonJS, Node test runner, local JSONL cursors.

1. Add failing parser tests for continuation, replacement human prompts, heartbeat envelopes, and unknown tool output.
2. Add Windows ingestion regression covering existing alias cursors and quarantine; verify failures before implementation.
3. Implement scoped recovery and bump parser version for transactional replay.
4. Run targeted and full tests, isolated selftest, and read-only replay against both affected transcripts.
5. Update deployment manifests, commit, integrate main, push, reinstall both plugins, and verify live ingestion and failed report recovery.
6. Record verified findings in pwiki and commit/push its scoped update.

The user approved this repair and deployment scope after the read-only diagnosis. Alternatives rejected: silently dropping every prompt-less turn loses evidence; reusing the last completed prompt invents associations.
