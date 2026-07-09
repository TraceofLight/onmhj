# 🤔 onmhj

AI-session worklog capture for Codex and Claude Code.

`onmhj` records local AI coding-session events, merges them across devices, and publishes daily worklogs to a git-backed report repository. It is built for "what did I do today?" capture; `ejmhj` consumes those logs for "what did I do yesterday?" reports.

[Korean README](./docs/README.ko.md) · [Installation](./docs/installation.md)

## Why

- Local-first hooks: session events append to local JSONL, not directly to git.
- Git-backed history: `flush` writes raw JSONL and daily Markdown into a separate report repo.
- Multi-device safe: each computer has a `deviceId`; existing raw logs are pulled, merged, and deduped.
- Automatic catch-up: background jobs retry every unconfirmed report date until `confirmedThrough` advances.
- Agent auth by default: daily report generation uses the active Codex/Claude Code auth unless API mode is explicitly enabled.

## Install

See [docs/installation.md](./docs/installation.md).

Agent handoff prompt:

```txt
Read docs/installation.md and install onmhj for Codex.
Use /path/to/onmhj-storage as the report repo.
After installing, run the smoke test and flush one report.
```

## Quick Start

After install, register the report repo:

```sh
node bin/onmhj.js register /path/to/worklog-git-repo --prompt=preview --timezone=Asia/Seoul
```

Set the device, owner, report language, and auth policy:

```sh
node bin/onmhj.js config \
  --device-id=macbook-pro \
  --owner-name="Your Name" \
  --owner-email=you@example.com \
  --report-lang=ko \
  --report-auth=agent
```

Check capture status:

```sh
node bin/onmhj.js status
```

Manual flush remains available:

```sh
node bin/onmhj.js flush 2026-07-09
node bin/onmhj.js flush 2026-07-09 --no-push
```

## Workflow

![onmhj workflow](./docs/assets/workflow.svg)

`confirmedThrough` advances only in date order. If an earlier report is waiting for retry, later jobs stay pending. If another device later exposes an older `confirmedThrough`, the floor drops and affected dates are queued again.

## Commands

| Command | Purpose |
| --- | --- |
| `onmhj register <repo>` | Set the external report repo. |
| `onmhj config ...` | Update timezone, device id, owner, language, auth, and API settings. |
| `onmhj status` | Show config, local event count, confirmed floor, and job counts. |
| `onmhj flush [date]` | Merge local/report events, regenerate daily Markdown, commit, and push. |
| `onmhj inject --text=...` | Add one normalized manual event. |
| `onmhj import <events.jsonl>` | Bulk import normalized JSONL events. |
| `onmhj worker` | Process pending report jobs in the background. |

## Backfill

Manual event:

```sh
node bin/onmhj.js inject \
  --date=2026-07-08 \
  --cwd=/path/to/repo \
  --source=manual \
  --source-id=manual-2026-07-08-1 \
  --text="Work summary"
```

Bulk import:

```sh
node bin/onmhj.js import /tmp/onmhj-backfill.jsonl
```

Git-history backfills must include only commits authored or committed by the configured owner identity.

## Storage

Local machine:

- config: `~/.config/onmhj/config.json`
- events: `~/.local/state/onmhj/events/YYYY-MM-DD.jsonl`
- internal logs: `~/.local/state/onmhj/internal/YYYY-MM-DD.jsonl`
- report jobs: `~/.local/state/onmhj/jobs/reports/YYYY-MM-DD.json`
- local confirmed watermark: `~/.local/state/onmhj/jobs/reports/confirmed.json`
- worker log: `~/.local/state/onmhj/worker.log`

Report repo:

- raw events: `raw/ai-sessions/YYYY-MM-DD.jsonl`
- daily report: `daily/YYYY-MM-DD.md`
- device confirmations: `state/devices/DEVICE_ID.json`

## Safety

- Hooks append locally only.
- Git sync and push run only during `flush` or worker-driven report jobs.
- Prompt capture defaults to `preview`; use `full` or `off` as needed.
- Prompt/report inputs get best-effort redaction for token, password, bearer credential, private-key, and API-key-like patterns.
- Local report dates use the configured timezone; event spool filenames use UTC.
