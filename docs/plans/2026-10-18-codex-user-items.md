# Codex UserMessage Item Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recover human requests stored only in Codex `item_completed.UserMessage` records and replay affected transcripts after upgrading.

**Architecture:** Read matching-turn user items as fallback prompts. Explicit `user_message` and linked `response_item` prompts remain authoritative. Preserve image-only requests with the existing `[image]` convention and reject malformed user items. Bump parser version 12 to 13 and plugin version 0.1.14 to 0.1.15.

**Tech Stack:** Node.js standard library, `node:test`.

## Design

- Parse the native user item; do not rewrite original transcripts or suppress quarantine errors.
- Prefer canonical prompt records over fallback user items in either arrival order.
- Keep matching turn identity, pending turns, replay replacement, and unrelated event types unchanged.
- Keep ingestion-lock scheduling changes outside this parser fix.

## Implementation

1. Add parser regressions in `tests/session-parsers.test.js` for text/images, canonical precedence, mismatched turns, and malformed content. Add a version-12 compressed cursor/quarantine recovery test in `tests/session-ingestion.test.js`.
2. Run `node --test tests/session-parsers.test.js tests/session-ingestion.test.js`; confirm the new regressions fail before editing production code.
3. Add native user-item fallback handling in `bin/session-parsers.js`; increment `SESSION_PARSER_VERSION` in `bin/onmhj.js` and update the existing version assertion.
4. Bump `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` to `0.1.15`; document replay behavior in `CHANGELOG.md` and `docs/installation.md`.
5. Run `node --test tests/*.test.js`, `node bin/onmhj.js selftest`, and replay the original compressed transcript without adaptation. Review the diff before integrating.
6. Refresh this device's installations and run `sessions` without a concurrent report worker; verify quarantine recovery before restarting the worker.
