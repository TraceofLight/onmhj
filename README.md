# onmhj

오늘뭐했지. Codex hook 이벤트를 로컬 JSONL로 쌓고, 등록한 별도 git repo로 하루치 기록을 push한다.

## 원칙

- 기존 wiki repo를 기본값으로 쓰지 않는다.
- hook 안에서는 로컬 append만 한다.
- git sync/push는 명시적으로 `flush`할 때만 한다.
- 프롬프트 저장 기본값은 `preview`다. 필요하면 `full` 또는 `off`로 바꾼다.
- 이벤트 timestamp와 local event 파일명은 UTC 기준이다.
- `today`/`yesterday` 같은 날짜 판단과 report 날짜는 사용자 컴퓨터 timezone 기준이다.

## 사용

등록:

```sh
node bin/onmhj.js register /path/to/worklog-git-repo --prompt=preview
```

timezone 명시:

```sh
node bin/onmhj.js register /path/to/worklog-git-repo --timezone=Asia/Seoul
```

상태:

```sh
node bin/onmhj.js status
```

오늘치 기록 생성, commit, push:

```sh
node bin/onmhj.js flush
```

push 없이 확인:

```sh
node bin/onmhj.js flush 2026-07-09 --no-push
```

## Codex hook 연결

`hooks/codex-hooks.json` 내용을 `~/.codex/hooks.json`에 병합한다.

## Codex plugin 설치

이 repo를 local marketplace로 등록한 뒤 플러그인을 설치한다.

```sh
codex plugin marketplace add /path/to/user/Documents/Github/onmhj
codex plugin add onmhj@onmhj-local
```

설치 후 `/hooks`에서 hook을 승인하고 새 세션을 시작한다.

기록 위치:

- config: `~/.config/onmhj/config.json`
- local events: `~/.local/state/onmhj/events/YYYY-MM-DD.jsonl` UTC date
- registered repo raw: `raw/ai-sessions/YYYY-MM-DD.jsonl`
- registered repo daily: `daily/YYYY-MM-DD.md` local date
