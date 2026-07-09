# onmhj

`onmhj` packages "what did I do today?" as a Codex and Claude Code plugin. It records hook events to local JSONL, then flushes daily logs to a registered git repo.

`ejmhj` is the companion "what did I do yesterday?" report flow.

Korean documentation: [docs/README.ko.md](./docs/README.ko.md)

## Principles

- Do not use an existing wiki repo as the default.
- Hooks only append local records.
- Git sync and push only happen when `flush` is run explicitly.
- Prompt capture defaults to `preview`. Use `full` or `off` when needed.
- Stored prompts and report inputs get best-effort redaction for token, password, and key-like patterns.
- Event timestamps and local event filenames use UTC.
- `today`/`yesterday` decisions and report dates use the user's local timezone.

## Usage

Register:

```sh
node bin/onmhj.js register /path/to/worklog-git-repo --prompt=preview
```

Set timezone:

```sh
node bin/onmhj.js register /path/to/worklog-git-repo --timezone=Asia/Seoul
```

Status:

```sh
node bin/onmhj.js status
```

Flush today's records, commit, and push:

```sh
node bin/onmhj.js flush
```

Flush without pushing:

```sh
node bin/onmhj.js flush 2026-07-09 --no-push
```

## Install

Follow [Installation](./docs/installation.md).

Prompt an agent like this:

```txt
Read docs/installation.md and install onmhj for Codex.
Use /path/to/user/Documents/Github/onmhj-storage as the report repo.
After installing, run the smoke test and flush one report.
```

Claude Code can also install from the local marketplace.

Record locations:

- config: `~/.config/onmhj/config.json`
- local events: `~/.local/state/onmhj/events/YYYY-MM-DD.jsonl` UTC date
- internal logs: `~/.local/state/onmhj/internal/YYYY-MM-DD.jsonl` UTC date, prompt excluded
- registered repo raw: `raw/ai-sessions/YYYY-MM-DD.jsonl`
- registered repo daily: `daily/YYYY-MM-DD.md` local date
