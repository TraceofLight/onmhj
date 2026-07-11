---
description: Configure, inspect, or flush the onmhj AI-session worklog
argument-hint: "<register|config|status|flush|inject|import|worker> [arguments]"
---

Run the installed onmhj CLI with `$ARGUMENTS`, then report its output concisely.

Resolve the plugin root from `CODEX_PLUGIN_ROOT`, then `CLAUDE_PLUGIN_ROOT`, then `ONMHJ_ROOT`. Run:

```sh
node "$PLUGIN_ROOT/bin/onmhj.js" $ARGUMENTS
```

Do not invent unsupported aliases. If no arguments were supplied, run `status`. Before `flush`, state that it commits and pushes the registered report repository unless `--no-push` was supplied.
