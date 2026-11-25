function usage() {
  return [
    'Usage:',
    '  onmhj hook <event>',
    '  onmhj register <git-repo-path> [--timezone=Area/City] [--device-id=ID] [--owner-name=NAME] [--owner-email=EMAIL] [--auto-report=true|false] [--report-lang=en|ko] [--report-auth=agent|api] [--report-agent=auto|codex|claude]',
    '  onmhj config [--timezone=Area/City] [--device-id=ID] [--owner-name=NAME] [--owner-email=EMAIL] [--auto-report=true|false] [--report-lang=en|ko] [--report-auth=agent|api] [--report-agent=auto|codex|claude] [--report-agent-model=MODEL] [--report-agent-effort=low|medium|high] [--report-timeout-minutes=N] [--report-api-base=URL] [--report-model=MODEL] [--report-api-key-env=NAME] [--report-api-key-file=PATH] [--report-api-effort=low|medium|high] [--report-segment-agent=true|false] [--report-revise=true|false] [--report-pipeline=summary|facts] [--report-api-light-effort=none|minimal|low|medium] [--report-prefetch=true|false]',
    '  onmhj inject --text=TEXT [--date=YYYY-MM-DD] [--cwd=PATH] [--source=NAME] [--source-id=ID]',
    '  onmhj import <events.jsonl>',
    '  onmhj sessions [--publish] [--no-push]',
    '  onmhj catchup',
    '  onmhj schedule install|uninstall|status',
    '  onmhj flush [YYYY-MM-DD] [--no-push]',
    '  onmhj ejmhj [YYYY-MM-DD] [--no-push]',
    '  onmhj worker',
    '  onmhj status',
    '  onmhj selftest',
  ].join('\n');
}

module.exports = {
  usage,
};
