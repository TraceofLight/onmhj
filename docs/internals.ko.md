# Internals

[README](./README.ko.md)의 구현 세부 사항입니다([English](./internals.md)). 설치와 설정은 [installation.md](./installation.md)를 참고하세요.

## 캡처와 발행

- local-first hook: 세션 이벤트는 git에 바로 쓰지 않고 local JSONL에 append합니다.
- git-backed history: `flush`가 별도 report repo에 canonical raw JSONL을 씁니다.
- `flush`와 worker report job은 쓰기 전에 report repo에서 `git pull --rebase --autostash`를 실행합니다. `onmhj flush` 밖에서 report repo를 직접 수정하거나 custom backfill script를 돌릴 때는 먼저 report repo를 pull한 뒤, 기존 raw event를 merge/dedupe해야 합니다.

## 보고서 생성

- automatic final reports: report job이 plugin runtime에 맞는 로컬 Claude Code 또는 Codex 로그인이나 OpenAI 호환 API(key는 환경변수 또는 `--report-api-key-file`)를 통해 `reports/YYYY-MM-DD.md` 최종보고서를 만듭니다.
- chunked generation: 큰 작업일은 세션을 보존한 약 20 KiB 청크로 나누고 최대 3개 격리 agent가 병렬 요약한 뒤, 최종 입력 상한 안에서 계층 병합해 검증된 report로 만듭니다.
- fact-first pipeline: `--report-pipeline=facts`는 작은 로컬 모델용 opt-in 대안이며(기본값은 `summary`), `--report-segment-agent`와 `--report-revise`로 선택적 품질 보강 단계를 추가합니다. 자세한 설정은 [Installation](./installation.md#configure-report-repo)을 참고하세요.
- agent auth default: `report-agent=auto`는 현재 plugin runtime의 로컬 로그인을 쓰며, `codex` 또는 `claude`로 명시할 수 있습니다. API mode는 공용입니다.
- native executable override: 비표준 설치 경로는 `ONMHJ_CLAUDE_EXECUTABLE` 또는 `ONMHJ_CODEX_EXECUTABLE`로 지정합니다.

timeout, 검증, 재시도 규칙은 [Safety](#safety)를 참고하세요.

## 다중 기기와 catch-up

- multi-device safe: 컴퓨터마다 `deviceId`를 두고, 기존 raw 로그를 pull/merge/dedupe합니다.
- automatic catch-up: background job이 확정되지 않은 날짜를 `confirmedThrough`가 전진할 때까지 재시도합니다.
- `confirmedThrough`는 device별로 날짜 순서대로만 전진합니다. 앞 날짜 report가 retry 대기 중이면 뒤 날짜 job은 pending 상태로 둡니다. 느린 device는 자기 local event를 기준으로 catch-up하며, 그 device의 오래된 watermark 때문에 다른 device의 정상 final report를 다시 생성하지 않습니다.

## 확정

최종보고서 검증과 raw, report, device confirmation 커밋이 모두 성공해야 날짜를 확정합니다. 완료 상태였더라도 report가 없거나 형식이 잘못되면 자동으로 다시 queue합니다.

`ejmhj --no-push`는 raw와 최종보고서를 생성·커밋하지만 confirmation을 쓰지 않습니다. `flush --no-push`는 raw 근거만 생성·커밋합니다. 일반 `ejmhj`는 ordered job queue를 사용하므로 뒤 날짜가 앞선 retry를 건너뛰지 않고 confirmation도 역행하지 않습니다.

## Backfill

수동 이벤트:

```sh
node bin/onmhj.js inject \
  --date=2026-07-08 \
  --cwd=/path/to/repo \
  --source=manual \
  --source-id=manual-2026-07-08-1 \
  --text="작업 요약"
```

Bulk import:

```sh
node bin/onmhj.js import /tmp/onmhj-backfill.jsonl
```

OpenAI-compatible capture record는 `provider`, `tsUtc`, `cwd`, 전체 `request`와 `response` object를 포함합니다. importer는 canonical user message, 최종 assistant content, model, tool name만 유지합니다. provider reasoning field와 tool argument는 검증하지만 저장하지 않습니다.

git-history 백필은 설정된 owner identity가 author 또는 committer인 커밋만 포함해야 합니다.

custom backfill은 최신 report repo 상태에서 시작해야 합니다. `raw/`, `reports/`, `state/`를 쓰기 전에 report repo에서 `git pull --rebase --autostash`를 실행합니다.

## Canonical Session

`onmhj sessions`는 Codex, Claude, DSH transcript를 증분 수집합니다. 각 canonical `AISessionTurn`에는 실제 사용자 요청과 존재하는 경우 최종 답변만 포함됩니다. 알려진 tool result, skill injection, notification, command, compaction record는 원본 transcript에만 남깁니다. Canonical user prompt와 최종 answer는 redaction 후 전체를 저장합니다.

최종 assistant 답변이 인용한 공개 링크와 DOI는 raw evidence에 저장되어 최종보고서에 반영됩니다. 최종 assistant 답변에 인용된 공개 Markdown 링크, HTTP(S) URL, DOI는 turn의 `references` 배열로 정규화합니다. 로컬 파일, localhost, 사설망 주소, 로컬 전용 hostname, 인증정보가 포함된 URL과 민감한 인증 query parameter가 있는 URL은 제외하고 추적 parameter와 fragment는 제거합니다. 새 최종보고서는 작업을 번호가 있는 Task로 묶고 배경·과정·결정·결과를 Task 안에 작성하며, 각 reference는 관련 Task의 `참고 자료` 또는 `References` 하위 섹션에만 배치합니다. Tool record와 browsing history는 수집하지 않습니다.

DSH에는 lifecycle hook이 없으므로 `$DSH_HOME/sessions`(기본 `~/.dsh/sessions`)의 세션은 scan으로만 수집합니다. 고정된 checkout에서 `onmhj schedule install`을 한 번 실행하면 1시간마다 수집과 report 예약을 수행합니다. 자세한 내용은 [Installation](./installation.md#dsh)을 참고하세요. DSH subagent 세션과 fork 세션에 복사된 부모 기록은 제외하고, subagent 결과 수신 후 사용자 prompt 없이 이어진 turn은 직전 사용자 turn의 답변에 이어 붙입니다.

`onmhj config --auto-report=false`를 설정하면 `SessionStart`가 report job을 예약하지 않습니다. 이후 `onmhj sessions --publish`는 registered repo를 pull하고 unresolved quarantine이 없는지 확인한 뒤, 성공적으로 replay한 현재 기기의 session 범위만 `raw/ai-sessions`에서 교체해 커밋과 push를 각각 한 번만 수행합니다. 다른 기기, 다른 session, 다른 event type과 `reports/`, report job, confirmation은 변경하지 않습니다.

파일 cursor는 `~/.local/state/onmhj/session-ingest/`에 있습니다. parser version replay는 transcript 전체 파싱이 성공한 뒤에만 이전 canonical 결과를 교체합니다. 관련 record 파싱이 실패하면 해당 byte offset에서 멈추고 metadata-only quarantine을 남기며, 실패한 replay는 기존 canonical 집합과 처음부터 다시 시도할 수 있는 cursor를 유지합니다.

## Storage

Local machine:

- config: `~/.config/onmhj/config.json`
- events: `~/.local/state/onmhj/events/YYYY-MM-DD.jsonl`
- internal logs: `~/.local/state/onmhj/internal/YYYY-MM-DD.jsonl`
- report jobs: `~/.local/state/onmhj/jobs/reports/YYYY-MM-DD.json`
- 재시도 가능한 report part: `~/.local/state/onmhj/report-parts/YYYY-MM-DD/INPUT_HASH/`
- local confirmed watermark: `~/.local/state/onmhj/jobs/reports/confirmed.json`
- worker log: `~/.local/state/onmhj/worker.log`
- transcript cursor와 quarantine: `~/.local/state/onmhj/session-ingest/`

Report repo:

- raw events: `raw/ai-sessions/YYYY-MM-DD.jsonl`
- final report: `reports/YYYY-MM-DD.md`
- device confirmations: `state/devices/DEVICE_ID.json`

## Safety

- hook은 local append만 합니다.
- git sync/push는 `sessions --publish`, `flush`, 또는 worker 기반 report job에서만 실행합니다.
- `flush`/worker는 쓰기 전에 pull합니다. 직접 report repo를 수정하거나 custom backfill을 실행하면 동일한 pull을 수동으로 먼저 해야 합니다.
- Canonical prompt와 최종 answer는 전체를 수집하며 reasoning과 tool argument는 저장하지 않습니다.
- Reference는 최종 assistant 답변에 인용된 공개 URL만 수집하며 페이지 본문, 로컬 자료, browsing tool history는 저장하지 않습니다.
- 전체 report pipeline은 생성과 검증이 모두 끝난 뒤에만 새 raw, report, confirmation을 씁니다. 기존 report를 재생성할 때는 모든 비제목 줄을 보존해야 하며, 검증에서 거부된 결과는 세 산출물을 모두 변경하지 않습니다.
- prompt/report input과 생성된 output, backend 오류 상세에는 token, password, bearer credential, private key, API key류 패턴에 대한 best-effort redaction을 적용합니다.
- native agent report는 격리된 임시 디렉터리에서 non-interactive로 실행합니다. Codex는 user config와 rule을 무시하고 read-only sandbox에서 불필요한 tool을 비활성화합니다. Claude Code는 safe mode에서 customization, tool, browser integration, session persistence를 비활성화합니다. Evidence는 신뢰할 수 없는 데이터로 취급합니다.
- 각 model 호출은 기본 15분까지 기다리며 설정으로 변경할 수 있습니다. 전체 report job에는 별도의 wall-clock 제한이 없습니다.
- chunked report generation은 JSONL record나 AI turn의 중간을 자르지 않습니다. Map summary는 전달받은 모든 evidence ID를 포함해야 하며, invalid part만 validation 사유와 함께 최대 두 번 재시도하고 valid part는 cache에서 재사용합니다.
- POSIX 호환 파일시스템에서는 재시도용 report-part 디렉터리와 파일 권한을 각각 `0700`, `0600`으로 설정해 현재 사용자만 읽고 쓸 수 있게 합니다.
- report repo에 이미 staged change가 있으면 자동 발행을 거부하며 repo 전체 publication lock을 사용합니다.
- report local date는 설정 timezone 기준이고, event spool 파일명은 UTC 기준입니다.

## Development

repo 루트에서 테스트를 실행합니다.

```sh
node --test tests/*.test.js
```

테스트 파일은 glob으로 넘겨야 하며, `tests/` 디렉터리를 넘기면 동작하지 않습니다. `node`가 `PATH`에 없으면 `bin/onmhj-node`를 쓰세요. 이 wrapper는 `PATH`의 `node`, `mise exec -- node`, ChatGPT 앱에 포함된 Node 순서로 찾아 같은 인자로 실행하고, 모두 없으면 exit 127로 종료합니다.

```sh
bin/onmhj-node --test tests/*.test.js
```
