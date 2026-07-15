---
description: Generate yesterday's final onmhj report, or a specified work date
argument-hint: "[YYYY-MM-DD] [--no-push]"
---

Run the installed onmhj `ejmhj` command with `$ARGUMENTS`, then report its output concisely.

Resolve the plugin root from `CODEX_PLUGIN_ROOT`, then `CLAUDE_PLUGIN_ROOT`, then `ONMHJ_ROOT`. Run:

```sh
node "$PLUGIN_ROOT/bin/onmhj.js" ejmhj $ARGUMENTS
```

With no date, this publishes raw evidence and the final report for yesterday in the configured timezone. The final report uses the work date. State before running that it commits and pushes the registered report repository unless `--no-push` was supplied.
