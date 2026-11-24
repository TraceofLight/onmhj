# Local LLM report evaluation (2026-11)

How the fact pipeline (`--report-pipeline=facts`) was measured against Claude, so the comparison can be rebuilt later from the stored raw sessions. The working harness was deleted after release 0.1.17; this document is the reproduction recipe.

## Inputs

- Raw evidence: `onmhj-storage/raw/ai-sessions/2026-11-14.jsonl` (30 turns) and `2026-11-22.jsonl` (59 turns). Both days mix Codex, Claude, and DSH turns; 11-14 is a short day used for fast iteration, 11-22 is a long day used as the hold-out check.
- Reports under test are generated from a separate state directory and a throwaway clone of the storage repository, with `onmhj ejmhj <date> --no-push`, so production state and storage are never touched.

## Gold checklist

One JSON file per day, built once by a subagent that reads the whole raw file, then reviewed by hand. Keep it outside any pushed repository; it contains private infrastructure details.

```json
{
  "date": "YYYY-MM-DD",
  "tasks": [{ "id": "G1", "title": "...", "target": "...", "turns": ["<evidenceId>", "..."] }],
  "facts": [{ "id": "F1", "task": "G1", "turn": "<evidenceId>", "fact": "Korean sentence", "values": ["exact values"], "status": "확인|예상|권고|계획|미확인", "importance": "core|detail" }],
  "superseded": [{ "old": "value or claim", "new": "final value", "turn": "<evidenceId>" }],
  "resolved_followups": ["items that were open at some point and later done"],
  "open_followups": ["items still open at the end of the day"]
}
```

- Tasks are goal-level units (one user objective), each listing the raw turns that serve it. Task granularity is subjective; do not tune grouping rules to one day.
- Facts carry the epistemic status stated in the raw evidence, so upgraded claims can be detected. `core` facts are what a daily report must keep (request, main work, decisions and reasons, final results with key numbers and commits, remaining work); everything else is `detail`.
- Sizes used: 11-14 had 5 tasks / 61 facts (21 core), 11-22 had 16 tasks / 126 facts (45 core).

## Judge

A fresh subagent per report, told not to read earlier judgments. Instructions used verbatim:

```text
You evaluate one Korean daily worklog report against a fixed gold checklist. Do not modify any file except the output JSON path you are given.

Inputs: gold checklist gold-<date>.json, raw evidence <date>.jsonl (fields: sourceId, prompt, assistantResponse), and the report markdown.

Write a JSON file with exactly:
{
  "facts": [{"id":"F1","verdict":"correct|wrong_value|wrong_status|missing","line":<report line number or null>,"note":"short"}],   // one entry for EVERY gold fact
  "extra_errors": [{"line":N,"claim":"report text","raw":"what raw says"}],   // report claims NOT in gold that are wrong vs raw
  "stale_followups": [{"line":N,"item":"..."}],   // follow-ups listed as remaining that gold marks resolved or raw shows were done
  "mixed_tasks": [{"task":"T#","why":"unrelated targets/purposes merged"}],
  "split_tasks": [{"tasks":"T#,T#","why":"one gold task needlessly split"}],
  "misplaced_sections": <int, bullets in the wrong subsection>,
  "korean_issues": [{"line":N,"text":"..."}],
  "usefulness": <0-10, how well a reader quickly answers "what did I do that day, why were the key decisions made, what remains" from this report alone. The report is intentionally concise: omitting detail-level facts is fine and must not lower usefulness; padding, repetition, and burying the main work in minor details should lower it>
}
Verdict rules: correct = present with correct values and correct epistemic status (an expectation written as "확인했다" is wrong_status); wrong_value = present but a number/hash/version/path/target/causal claim is wrong or uses a superseded value; missing = not stated anywhere. Partial wording is fine if meaning and values match. Be strict and consistent; cite line numbers.
```

## Score (v2)

Five 0-10 components, averaged:

| Component | Formula |
|---|---|
| Coverage | 10 × correct core facts / core facts |
| Accuracy | 10 − 0.5 × errors per 100 task bullets; errors = wrong_value + wrong_status + extra_errors + stale_followups |
| Structure | 10 × turn-pair F1 − 0.25 × misplaced bullets per 100 task bullets |
| Korean | 10 − 2 × severe mixing hits (foreign scripts, leaked `{{ev:}}` or turn ids, English prose of 5+ lowercase words outside code, links, and quotes) |
| Usefulness | judge score |

- Task bullets exclude placeholders (`확인된 내용 없음`) and the references section.
- Turn-pair F1: each gold turn is assigned to the report task that holds most of its correctly located gold facts (judge line numbers); every pair of turns is then "same task" or not, compared with gold.
- Korean counts severe mixing only, by decision; style issues go to usefulness.

## Noise and procedure

- Re-judging the same report moved the average by about ±0.2; regenerating with the same code moved it by ±0.2-0.4. Compare versions on the mean of two runs, and confirm on the long day before adopting a change.
- Measure stage timing from the `report_facts` log (`stages`: calls, call seconds, wall seconds, prompt/output size).
- For refactors, record every model output once (keyed by prompt and options, in call order) and replay it against the new code; prompts and the final report must be byte-identical.

## Results at release 0.1.17

| Report | 11-14 average | 11-22 average | 11-22 size |
|---|---|---|---|
| Claude sonnet, summary pipeline (production report) | 9.08 | 8.89 | 38 KB |
| Claude sonnet, summary pipeline (regenerated) | 8.85 | 8.72 | 39 KB |
| Claude sonnet, fact pipeline | 8.68 | 8.78 | 58 KB |
| Local Qwen (`qwen3.8-flash-next-abl`), fact pipeline | 8.09-8.22 | 8.82 | 45 KB |

Token use with Claude sonnet (medium effort), from `claude -p --output-format json`:

| Day / pipeline | Calls | Input tokens (cache create + read) | Output tokens | Cost |
|---|---|---|---|---|
| 11-14 summary | 6 | ~69K | 26K | $0.42 |
| 11-14 facts | 50 | ~445K | 61K | $1.56 |
| 11-22 summary | 17 | ~265K | 103K | $1.65 |
| 11-22 facts | 136 | ~1.24M | 152K | $4.09 |

Conclusions: keep `summary` for Claude and Codex (the fact pipeline costs 2.5-3.7× without a quality gain); use `facts` for small local models, where single-pass summaries scored in the 5s. Local generation of 11-22 from scratch takes about 30 minutes, most of it in task writing. Rejected along the way: writing or grouping with thinking disabled (quality drop), fixed bullet-count limits (thin reports for large tasks), turn-link grouping and an extra task-merge pass (worse on the long day).
