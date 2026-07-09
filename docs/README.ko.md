# onmhj

`onmhj`는 "오늘뭐했지"를 모듈화한 Codex/Claude Code plugin이다. hook 이벤트를 로컬 JSONL로 쌓고, 등록한 별도 git repo로 하루치 기록을 push한다.

`ejmhj`는 "어제뭐했지"를 모듈화한 리포트 생성 흐름이다.

## 원칙

- 기존 wiki repo를 기본값으로 쓰지 않는다.
- hook 안에서는 로컬 append만 한다.
- 각 컴퓨터는 hostname 기반 기본 `deviceId`를 가지며 config로 바꿀 수 있다.
- git sync/push는 명시적으로 `flush`할 때만 한다.
- `flush`는 report repo를 먼저 pull하고, 기존 raw 로그와 현재 컴퓨터의 local event를 병합/dedupe한 뒤 commit한다.
- 일반적인 하루 단위 리포트 생성은 활성 Codex/Claude Code auth를 기본값으로 쓴다(`reportAuth=agent`).
- report markdown 언어는 `reportLanguage`를 따르며, 기본값은 사용자 locale에서 정한다.
- OpenAI 호환 API 설정은 대량 백필 작업용 선택 경로다.
- git-history 백필은 설정된 owner identity가 author 또는 committer인 커밋만 포함해야 한다.
- 프롬프트 저장 기본값은 `preview`다. 필요하면 `full` 또는 `off`로 바꾼다.
- 저장되는 프롬프트/리포트 입력은 token, password, key류 패턴을 best-effort로 redaction한다.
- 이벤트 timestamp와 local event 파일명은 UTC 기준이다.
- `today`/`yesterday` 같은 날짜 판단과 report 날짜는 사용자 컴퓨터 timezone 기준이다.

## Workflow

1. Codex 또는 Claude Code plugin을 설치한다.
2. `onmhj register`로 외부 report repo 하나를 등록한다.
3. Codex/Claude Code session 안에서 hook이 실행되고, redaction된 local JSONL event만 append한다.
4. 각 event에는 UTC 시간, local report date, repo path, session id, prompt preview, `deviceId`가 들어간다.
5. 백필은 필요할 때 `inject` 또는 `import`로 같은 local spool에 정규화 event를 넣는다.
6. `flush [date]`는 설정된 timezone의 날짜 기준 local event를 읽는다.
7. upstream이 있으면 `flush`가 report repo를 먼저 pull한다.
8. `flush`는 기존 raw report event와 현재 컴퓨터 local event를 병합하고 dedupe한다.
9. `flush`는 `raw/ai-sessions/YYYY-MM-DD.jsonl`을 쓰고 `daily/YYYY-MM-DD.md`를 재생성한다.
10. daily markdown은 `reportLanguage`를 따르고, plugin prompt는 영어로 유지한다.
11. `flush`는 `--no-push`가 없으면 commit 후 push한다.

여러 컴퓨터가 같은 report repo를 써도 된다. 각 컴퓨터에 안정적인 `deviceId`를 두면, flush 때 다른 device의 기존 event를 보존하고 합친 daily report를 다시 만든다.

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

현재 컴퓨터의 device id 설정:

```sh
node bin/onmhj.js config --device-id=macbook-pro
```

owner/report auth 정책 설정:

```sh
node bin/onmhj.js config --owner-name=TraceofLight --owner-email=you@example.com --report-lang=ko --report-auth=agent
```

대량 백필용 API 모드:

```sh
node bin/onmhj.js config --report-auth=api --report-api-base=https://example.com/v1 --report-model=model-name --report-api-key-env=ONMHJ_LLM_API_KEY
```

수동 이벤트 1건 주입:

```sh
node bin/onmhj.js inject --date=2026-07-08 --cwd=/path/to/repo --source=manual --source-id=manual-2026-07-08-1 --text="작업 요약"
```

정규화된 JSONL 이벤트 가져오기:

```sh
node bin/onmhj.js import /tmp/onmhj-backfill.jsonl
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
- registered repo raw: `raw/ai-sessions/YYYY-MM-DD.jsonl`, report local date 기준 병합본
- registered repo daily: `daily/YYYY-MM-DD.md` local date, device별/전체 repo 요약 포함
