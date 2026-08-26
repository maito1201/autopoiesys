# SCHEMA.md — `.os/` オンディスク形式契約

format_version: **0.1.0**（semver。`.os/config.yaml` に記録され、非互換変更は `autopoiesys migrate` が吸収する）

これは OSS Core とユーザー固有OS（`.os/`）を繋ぐ唯一の契約である。
Core はここに定義された形式以外を読み書きしない。`.os/` の外にも書かない。

## 共通規約

- 文字コード UTF-8、改行 LF、JSONはキーソート済みで出力される（同一入力→バイト同一出力）
- JSONL は追記専用。更新は `supersedes` 参照を持つ新レコードの追記で表現する
- ID は英数字とハイフン（`^[A-Za-z0-9][A-Za-z0-9_-]*$`）。慣例: Statement=S/obs-、Task=T、Failure=F、Research=R
- YAMLファイルは同梱パーサのサブセットのみ対応:
  インデントによるマップ/リスト、`- ` リスト、スカラー（文字列・数値・真偽・null）、
  `"..."` / `'...'` 引用、`#` コメント、`|` リテラルブロック、
  単一行フロースタイル（`{k: v}` / `[a, b]`、ネスト可）。
  アンカー・エイリアス・タグ・複数行フローは**非対応（明示エラー）**

## `.os/` レイアウト

| パス | 形式 | 内容 |
|---|---|---|
| goal.yaml | YAML | Goal Specification |
| config.yaml | YAML | format_version・Routing表・予算・strictness |
| world_model/events.jsonl | JSONL | Statement正本（追記専用） |
| world_model/snapshot.json | JSON | 再生成キャッシュ（`autopoiesys rebuild`） |
| world_model/vocabulary.yaml | YAML | predicate/tag 登録簿 |
| queries/*.yaml | YAML | Query定義 |
| evaluators/*.yaml | YAML | Evaluator仕様 |
| rules/*.yaml | YAML | コンパイル済みルール |
| tasks/tasks.jsonl | JSONL | タスク台帳 |
| evaluations/log.jsonl | JSONL | verdict台帳 |
| failures/ledger.jsonl | JSONL | Failure状態機械イベント |
| golden_tasks/*.yaml | YAML | Golden Task定義 |
| briefings/*.md | MD | T3投入用の厳選コンテキスト（git監査対象） |
| proposals/ | MD/diff | OSS Core等への変更提案の下書き |
| plugins/*.yaml | YAML | 逃げ道プラグイン宣言（**未実装** — Core側の実行・台帳記録の受け皿は将来版。現状はproposals/への還流を使う） |
| observations/costs.jsonl | JSONL | Token Ledger |
| observations/query_log.jsonl | JSONL | Query実行記録（切詰め・頻度） |
| observations/research.jsonl | JSONL | Researchセッション開閉と産出資産 |
| observations/regression.jsonl | JSONL | regression実行履歴（運用ヒント「そろそろregression」の判定基準） |

## goal.yaml

```yaml
goal: 自然文の目的（原文保持）
domain: software_engineering        # 値は自由。キーはCoreが知る抽象のみ
objectives:
  - implement_features
success_criteria:
  - id: sc-001
    statement: 変更がリポジトリの状態を改善する
    evaluator: requirement_satisfied   # evaluator ID または unbound
constraints:
  - id: c-001
    statement: mainへの直接pushをしない
    severity: hard                     # hard | soft
    evaluator: constraint_no_direct_push  # または unbound
autonomy:
  escalate_on:
    - architectural_ambiguity
optimization:
  - correctness
sources:
  - repo: .
notes: |
  ヒアリング原文などの自由記述
```

制約: `success_criteria[].evaluator` と `constraints[].evaluator` は必須
（未実装なら `unbound`）。`autopoiesys validate` が unbound を集計・警告する。

## Statement（world_model/events.jsonl の1行）

```json
{"id":"S0001","ts":"2026-08-26T00:00:00Z","type":"claim","body":"...",
 "subject":"S0002","predicate":"affects","object":"S0003",
 "links":[{"role":"supports","to":"obs-ab12cd34ef"}],
 "status":"hypothesis","confidence":0.61,"tags":["retention"],
 "provenance":{"source":"discover-domain","method":"llm","session":"R001"},
 "supersedes":"S0000"}
```

- `type`: entity | relationship | observation | claim | evidence | hypothesis |
  unknown | decision | constraint | goal | outcome | failure
- `status`: fact | hypothesis | unknown | retracted
- `links[].role`: supports | counters | about | derived_from | relates_to | caused_by | prevents
- `subject/predicate/object`: relationship用（任意）。predicateはvocabulary登録制（既定は警告）
- `confidence`: 0..1（任意）
- `provenance.method`: deterministic | llm | human
- 必須: id, ts, type, body, status, provenance

## Query定義（queries/*.yaml）

```yaml
name: get_constraints
description: 有効な制約を返す
params:
  tag:
    required: false
pipeline:
  - select: { type: constraint }
  - where: { status: [fact, hypothesis] }
  - where_param: { field: tags, contains: tag }   # paramが与えられた時のみ適用
  - expand: { roles: [supports, counters], direction: in, limit: 3 }
  - sort: { by: confidence, order: desc }
  - project: [id, body, status, confidence, tags, linked]
  - limit: 20
max_tokens: 1500
golden:                       # 任意。regression対象になる
  params: {}
  expect_min_count: 1
```

pipelineステップ（エンジン実装済みの全語彙）:
`select`（フィールド等値/所属）/ `where` / `where_param` / `expand`（リンク先添付）/
`sort` / `project` / `limit`。これ以外はエラー。

出力: `{query, params, count, total, truncated, results[]}`。
概算トークン（文字数/4）が max_tokens を超えると results を切詰め `truncated: true` と
`next_offset` を返す。全実行は observations/query_log.jsonl に記録される。

## Evaluator仕様（evaluators/*.yaml）

共通: `id`, `applies_to`（自由ラベル）, `tier`（T0|T1|T2|T3）, `method`

```yaml
# method: deterministic
id: constraint_check
applies_to: repo_change
tier: T0
method: deterministic
checks:
  - kind: file_exists          # file_exists | file_absent | file_matches |
    path: README.md            # file_not_matches | query_empty | query_nonempty
  - kind: file_not_matches
    path: core/store.js
    pattern: "console\\.log"
  - kind: query_empty
    query: find_violations
```

```yaml
# method: command
id: tests_pass
applies_to: repo_change
tier: T0
method: command
argv: [node, --test, tests/]
expect_exit: 0
timeout_ms: 120000
```

```yaml
# method: llm_judge
id: requirement_satisfied
applies_to: task_artifact
tier: T2
method: llm_judge
context_queries: [get_constraints]
rubric: |
  判定基準をここに書く。PASS/FAIL/UNCERTAINと根拠を返させる。
```

- deterministic / command は `autopoiesys evaluate` が直接実行し verdict を追記する
- llm_judge は `autopoiesys evaluate` が `.os/briefings/eval-<task>-<id>.md` を生成する。
  **新規の独立サブエージェント**（生成側の会話履歴を持たない）が briefing のみを読んで
  判定し、`autopoiesys verdict --file <json>` で記録する
- **外部記録の制限**: `autopoiesys verdict` が受理するのは method: llm_judge のevaluatorに対する
  verdictのみ。deterministic / command のverdictは `autopoiesys evaluate` の内部実行でしか書けず、
  外部からの provenance 自称（deterministic / replay）は llm に矯正される
- 集約規則: **deterministic/command の FAIL は llm_judge の PASS で覆せない**
  （同一evaluatorに後からllm verdictを積んでも、最新の決定的verdictがFAILなら覆らない）。
  また next-action の対象は task.evaluators と verdict記録済みevaluatorの和集合であり、
  評価後にevaluatorをタスクから外しても記録済みFAILは視界から消えない

## verdict（evaluations/log.jsonl の1行）

```json
{"ts":"...","task":"T001","evaluator":"tests_pass","verdict":"PASS",
 "evidence":["exit=0"],"rationale":"...","provenance":"deterministic",
 "tier":"T0","tokens":0}
```

`verdict`: PASS | FAIL | UNCERTAIN。
`provenance`: deterministic（コアが直接実行）| llm（独立サブエージェントの判定）|
human（人間の判定。外部記録で明示指定した場合のみ）|
replay（記録済みverdictのリプレイ。regressionやevaluateの--replayで使われる。
`autopoiesys evaluate --replay` は過去に記録されたllm/human判定と一致する値のみ受理する）。
`reason`（任意）: insufficient_evidence | model_limitation | conflicting_evidence —
Next Action Engine が COLLECT_EVIDENCE / DEEP_RESEARCH / RESOLVE_CONFLICT へ写像する。

## Task（tasks/tasks.jsonl の1行）

```json
{"id":"T001","ts":"...","objective":"...","status":"open",
 "artifacts":[{"path":"...","note":"..."}],"evaluators":["tests_pass"]}
```

`status` は追記で更新（同idの最新行が現在状態）。
`evaluators`: このタスクに適用するEvaluator ID列。

## Failure（failures/ledger.jsonl の1行 = 状態遷移イベント）

```json
{"id":"F001","ts":"...","state":"reported","severity":"high",
 "symptom":"...","source":"user_feedback","task":"T001",
 "fingerprint":"a1b2c3d4"}
```

状態機械（`autopoiesys failure transition` が遷移合法性と必須フィールドを検査）:

| 遷移先 | 必須フィールド |
|---|---|
| reported | symptom, source, severity, fingerprint(自動) |
| investigated | root_cause, why_undetected |
| classified | classification ∈ {missing_knowledge, missing_query, missing_constraint, missing_test, missing_evaluator, bad_workflow, bad_model} |
| upgrade_proposed | proposal（提案内容 or ファイルref） |
| implemented | assets[]（最低1件の golden_task と、最低1件の evaluator/rule/query/detector）, regression_ref |
| accepted_risk | reason, why_undetected（investigated済みで記録があれば省略可） |

`autopoiesys failure lint`: 非終端（implemented/accepted_risk 以外）のまま `stale_after_days`
（config、既定7日）を超えたFailureを違反として報告し、`autopoiesys regression` を不合格にする。

## Golden Task（golden_tasks/*.yaml）

```yaml
id: gt-001
description: 制約違反検出器が既知の悪い状態を検出できること
origin_failure: F001            # 任意
checks:
  - evaluator: constraint_check
    expected: PASS              # 現在の状態に対する期待verdict
  - evaluator: constraint_check
    fixture: .os/golden_tasks/fixtures/bad-example/   # 検出力テスト:
    expected: FAIL              # 悪いfixtureに対してFAILを出せること
  - evaluator: requirement_satisfied
    replay: PASS                # llm_judgeは記録済みverdictをリプレイ
```

- `fixture` 付き check は、そのディレクトリを作業対象として評価を実行する（検出力テスト）。
  **fixtureパスはrepoRoot（`autopoiesys regression --repo`、既定はcwd）相対で解決される** —
  `.os/` 配下に置く場合は `.os/` から書き始める
- llm_judge への `replay` は実LLMを呼ばず記録値を採用する（回帰の決定性）
- `autopoiesys regression`: 全golden task実行 + failure lint + `autopoiesys check` を集約し PASS/FAIL を返す

## config.yaml

```yaml
format_version: 0.1.0
os_version: 1                  # upgrade-os が増分
routing:
  T0: deterministic
  T1: { model: cheap,  use_for: [classification, summary, checklist] }
  T2: { model: mid,    use_for: [planning, integration] }
  T3: { model: high,   use_for: [unknown_problem, critical_failure, contradiction, os_redesign] }
  escalation:
    - uncertain_verdict
    - unknown_fingerprint
    - conflicting_evidence
budgets:
  research_tokens: 200000
strict_vocabulary: false
stale_after_days: 7
regression_every_days: 7   # この間隔を超えてregression未実行だと主要コマンドがヒントを出す
```

## Token Ledger（observations/costs.jsonl の1行）

```json
{"ts":"...","purpose":"discover-domain","tier":"T3","model":"...",
 "tokens_in":12000,"tokens_out":3000,"task":"T001","session":"R001",
 "asset_refs":["queries/get_constraints.yaml"]}
```

Skillは全LLM作業（自分自身の推論を含む）をここに自己申告する。
`autopoiesys metrics` が cost/task・tier別消費・cheap-path coverage・切詰め率を集計する。

## Researchセッション（observations/research.jsonl）

```json
{"ts":"...","id":"R001","event":"open","purpose":"..."}
{"ts":"...","id":"R001","event":"close","assets":["evaluators/x.yaml"]}
```

`autopoiesys research close` は assets が空のとき警告する（§14 資産化の出口検査）。
また当該セッションのToken Ledger合計が config.yaml の budgets.research_tokens を
超過している場合も警告する。
