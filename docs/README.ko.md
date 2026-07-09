# onmhj

`onmhj`는 "오늘뭐했지"를 모듈화한 Codex/Claude Code plugin이다. hook 이벤트를 로컬 JSONL로 쌓고, 등록한 별도 git repo로 하루치 기록을 push한다.

`ejmhj`는 "어제뭐했지"를 모듈화한 리포트 생성 흐름이다.

## 원칙

- 기존 wiki repo를 기본값으로 쓰지 않는다.
- hook 안에서는 로컬 append만 한다.
- git sync/push는 명시적으로 `flush`할 때만 한다.
- 프롬프트 저장 기본값은 `preview`다. 필요하면 `full` 또는 `off`로 바꾼다.
- 저장되는 프롬프트/리포트 입력은 token, password, key류 패턴을 best-effort로 redaction한다.
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

prompt 또는 timezone 설정 변경:

```sh
node bin/onmhj.js config --timezone=Asia/Seoul --prompt=preview
```

오늘치 기록 생성, commit, push:

```sh
node bin/onmhj.js flush
```

push 없이 확인:

```sh
node bin/onmhj.js flush 2026-07-09 --no-push
```

## 설치

자세한 절차는 [Installation](./installation.md)을 따른다.

에이전트에게 맡길 때는 이렇게 말한다:

```txt
Read docs/installation.md and install onmhj for Codex.
Use /path/to/user/Documents/Github/onmhj-storage as the report repo.
After installing, run the smoke test and flush one report.
```

Claude Code는 로컬 marketplace로 설치할 수 있다.

기록 위치:

- config: `~/.config/onmhj/config.json`
- local events: `~/.local/state/onmhj/events/YYYY-MM-DD.jsonl` UTC date
- internal logs: `~/.local/state/onmhj/internal/YYYY-MM-DD.jsonl` UTC date, prompt excluded
- registered repo raw: `raw/ai-sessions/YYYY-MM-DD.jsonl`
- registered repo daily: `daily/YYYY-MM-DD.md` local date
