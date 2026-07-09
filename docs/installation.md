# Installation

`onmhj` is installed as a local Codex plugin marketplace. It records hook events locally, then flushes daily raw/report files into a separate git repo chosen by the user.

## Prerequisites

- Node.js on `PATH` for non-interactive hook execution.
- Codex CLI with plugin support.
- A git repo for reports, separate from any wiki repo.

Example report repo:

```sh
/path/to/user/Documents/Github/onmhj-storage
```

## Codex From Local Checkout

From any directory:

```sh
codex plugin marketplace add /path/to/user/Documents/Github/onmhj
codex plugin add onmhj@onmhj-local
```

Then open `/hooks`, review and trust the `onmhj` lifecycle hooks, and start a new Codex session.

The marketplace manifest lives at:

```txt
.agents/plugins/marketplace.json
```

## Codex From GitHub

After the repo has been pushed, Codex can also install from GitHub:

```sh
codex plugin marketplace add TraceofLight/onmhj
codex plugin add onmhj@onmhj-local
```

If the marketplace was already added and the repo changed, refresh it:

```sh
codex plugin marketplace upgrade onmhj-local
codex plugin add onmhj@onmhj-local
```

## Configure Report Repo

Register the external storage repo:

```sh
node /path/to/user/Documents/Github/onmhj/bin/onmhj.js register /path/to/user/Documents/Github/onmhj-storage --prompt=preview --timezone=Asia/Seoul
```

Check config:

```sh
node /path/to/user/Documents/Github/onmhj/bin/onmhj.js status
```

Config is stored at:

```txt
~/.config/onmhj/config.json
```

Events spool locally at:

```txt
~/.local/state/onmhj/events/YYYY-MM-DD.jsonl
```

## Smoke Test

Run a short Codex session in a target repo:

```sh
codex exec --dangerously-bypass-hook-trust \
  -C /path/to/user/Documents/Workspace/execore-clone \
  "onmhj smoke test. Reply with the repo name and clean git status only."
```

Confirm events were captured:

```sh
node /path/to/user/Documents/Github/onmhj/bin/onmhj.js status
tail -n 5 ~/.local/state/onmhj/events/$(date -u +%F).jsonl
```

Flush to the report repo:

```sh
node /path/to/user/Documents/Github/onmhj/bin/onmhj.js flush
```

Expected outputs in the report repo:

```txt
raw/ai-sessions/YYYY-MM-DD.jsonl
daily/YYYY-MM-DD.md
```

`flush` commits and pushes unless `--no-push` is passed.

## Troubleshooting

If `codex plugin marketplace add` says the root has no supported manifest, check that `.agents/plugins/marketplace.json` exists.

If no events appear, open `/hooks`, trust the `onmhj` hooks, and start a new session. `SessionStart` only fires for new sessions.

If the hook cannot find Node, install Node or make sure the non-interactive shell used by Codex can resolve `node`.

## Claude Code

Claude Code support is planned but not packaged yet. Do not claim Claude installation works until the repo includes a `.claude-plugin/plugin.json` or equivalent Claude marketplace manifest.
