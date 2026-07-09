# Installation

`onmhj` is installed as a local Codex or Claude Code plugin marketplace. It records hook events locally, then flushes daily raw/report files into a separate git repo chosen by the user.

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

## Claude Code From Local Checkout

From any directory:

```sh
claude plugin marketplace add /path/to/user/Documents/Github/onmhj
claude plugin install onmhj@onmhj-local
claude plugin enable onmhj@onmhj-local
```

Restart Claude Code after installing so the hook settings reload.

## Configure Report Repo

Register the external storage repo:

```sh
node /path/to/user/Documents/Github/onmhj/bin/onmhj.js register /path/to/user/Documents/Github/onmhj-storage --prompt=preview --timezone=Asia/Seoul
```

Check config:

```sh
node /path/to/user/Documents/Github/onmhj/bin/onmhj.js status
```

Update prompt or timezone without changing the registered repo:

```sh
node /path/to/user/Documents/Github/onmhj/bin/onmhj.js config --timezone=Asia/Seoul --prompt=preview
```

Config is stored at:

```txt
~/.config/onmhj/config.json
```

Events spool locally at:

```txt
~/.local/state/onmhj/events/YYYY-MM-DD.jsonl
```

Internal operational logs are stored separately and do not include prompt text:

```txt
~/.local/state/onmhj/internal/YYYY-MM-DD.jsonl
```

## Privacy

`onmhj` redacts common token, password, secret, API key, bearer token, and private-key patterns before writing prompt text to local events or report repos.

This is a best-effort guard, not a full secret scanner. Keep `--prompt=preview` as the default. Use `--prompt=off` when working with credentials-heavy sessions.

When asking an agent to summarize or flush reports, include this instruction:

```txt
Before writing to the onmhj report repo, exclude or redact tokens, API keys, passwords, private keys, bearer credentials, cookies, and one-off secret values. Keep only the work reason, process, decisions, and results.
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
tail -n 20 ~/.local/state/onmhj/internal/$(date -u +%F).jsonl
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

If internal logs are empty too, the plugin hook is not running. Reinstall or re-trust the plugin hooks, then start a new Codex session.

If the hook cannot find Node, install Node or make sure the non-interactive shell used by Codex can resolve `node`.

## Claude Code

The Claude Code plugin manifest lives at:

```txt
.claude-plugin/plugin.json
```
