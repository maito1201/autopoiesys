# SCHEMA.md — `.os/` オンディスク形式契約

format_version: **0.2.0**（semver。`.os/config.yaml` に記録され、非互換変更は `autopoiesys migrate` が吸収する。
0.2はIntelligence Graph — relationship第一級化・capability型・traverse・gap — の追加的変更のみで、0.1のOSはそのまま有効）

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
| briefings/*.md | MD | T3投入用の厳選コンテキスト（git監査対象）。llm_judge用のbriefingには**artifactに実装が含まれるか**が明記され、含まれない場合は判定者に「実装に依存するrubric項目はUNCERTAIN」と指示される |
| proposals/ | MD/diff | OSS Core等への変更提案の下書き |
| plugins/*.yaml | YAML | 逃げ道プラグイン宣言（**未実装** — Core側の実行・台帳記録の受け皿は将来版。現状はproposals/への還流を使う） |
| observations/costs.jsonl | JSONL | Token Ledger（**自己申告**） |
| observations/context_log.jsonl | JSONL | briefing生成時のコンテキスト消費（**機械実測**。自己申告と違い、削減の主張をここだけで検証できる） |
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
sources:                             # 知識の取込対象。多リポジトリ横断が前提
  - scope: service-api               # World Model上の宛先名（省略時はrepoのbasename）
    repo: /abs/path/to/repo          # 相対パスは .os/ の親ディレクトリ基準
    rule_docs: [CLAUDE.md]           # 作業規約Markdown。見出し単位でplaybook Statement化
    memory_dir: /abs/path/to/memory  # 1ファイル1事実のfrontmatter付きMarkdown索引
excluded_sources:                    # 発見したが取り込まない知識源（reason必須）
  - path: ./AGENTS.md
    reason: CLAUDE.mdと同内容
notes: |
  ヒアリング原文などの自由記述
```

制約: `success_criteria[].evaluator` と `constraints[].evaluator` は必須
（未実装なら `unbound`）。`autopoiesys validate` が unbound を集計・警告する。
`sources[].scope` は重複不可（別リポジトリの知識が同じ宛先に混ざる事故を防ぐ）。

`sources` に登録されていない知識源は `autopoiesys sources scan` が候補として列挙する
（探索対象: 各repoのルート直下の CLAUDE.md / AGENTS.md / CONTRIBUTING.md / .cursorrules /
.clinerules / .github/copilot-instructions.md、ネストした CLAUDE.md / AGENTS.md、
`~/.claude/projects/<パスから導くslug>/memory`、`~/.claude/CLAUDE.md`。
vendor / node_modules / Pods / dist 等の他人の規約は対象外）。
候補は `sources` へ登録するか `excluded_sources` に理由付きで宣言するまで `undecided` として
残り、`sources scan` は exit 1 を返す — 取りこぼしと意図した除外を区別するための契約である。

## Statement（world_model/events.jsonl の1行）

```json
{"id":"S0001","ts":"2026-08-26T00:00:00Z","type":"claim","body":"...",
 "subject":"S0002","predicate":"affects","object":"S0003",
 "links":[{"role":"supports","to":"obs-ab12cd34ef"}],
 "status":"hypothesis","confidence":0.61,"tags":["retention"],"scope":["service-api"],
 "provenance":{"source":"discover-domain","method":"llm","session":"R001"},
 "supersedes":"S0000"}
```

- `type`: entity | relationship | observation | claim | evidence | hypothesis |
  unknown | decision | constraint | goal | outcome | failure | capability
- `status`: fact | hypothesis | unknown | retracted
- `links[].role`: supports | counters | about | derived_from | relates_to | caused_by | prevents
- `confidence`: 0..1（任意）
- `provenance.method`: deterministic | llm | human
- `provenance.task`: 任意。run-task中の還流（`statement add|supersede`）で出所タスクを記録する
- `provenance.series`: 任意。決定的取込が「同じ観測対象の世代」を識別するキー。
  再取込時は (scope, series) が一致する現在Statementをsupersedeする（冪等の実装根拠）
- `scope`: 任意。このStatementが適用される宛先（対象リポジトリ）の配列。
  `tags` が「話題」、`scope` が「宛先」という分離であり、両者は別フィールドなので
  Queryの `where` で **AND** に組める（同一フィールドの複数値はORにしかならない）。
  複数要素は横断知識（例: `["service-api","mobile-app"]` = 両者間の契約）を表し、
  どちらのscopeで引いても返る。**省略は「宛先に依らない知識」**（製品仕様・ビジネス構造等）を
  意味し、scope絞りのQueryには乗らない代わりに話題tagで引ける。
  値は `world_model/vocabulary.yaml` の `scopes` が登録簿（未登録はcheckで全件警告）
- `blocks` / `importance`: **type: unknown でのみ使える**。`blocks` は
  「このUnknownが塞いでいる判断・基準のID」の文字列配列（判断・台帳など別空間のIDも
  入りうるため実在は検証しない）、`importance` は 0..1。
  Unknownを「知らないことの一覧」で終わらせず、**どの判断が止まっているか**で
  並べ替えられるようにするためのもの
- `decision` 型の任意フィールド: `options`（検討した選択肢）・`chosen`（採った手。
  optionsを列挙したなら必ずその中の1つ）・`criteria`（判断基準）・`expected_outcome`・
  `review_after`（日付 or イベント名。日付として読める場合だけ期限切れ判定の対象になる）
- `outcome` 型の任意フィールド: `result`（met | unmet | unclear）・`note`・`decision`（元の決定ID）。
  レビューは元のdecisionを**supersedeせず**、outcomeを追記して `links[].derived_from` で張る
  （決定の記録そのものは書き換えない）。`result: unmet` は
  「ログで終わらせずFailureとして起票せよ」という警告を伴う
- 必須: id, ts, type, body, status, provenance

## Relation（type: relationship のStatement — 第一級の関係）

関係には2層ある:

- **links[]** — Statementについての軽量配管（証拠の極性・由来）。属性は `{role, to}` のみ
- **relationship Statement** — confidence・条件・証拠を持つ領域知識の第一級の辺。
  独立したStatementなので、端点に触れずに単体でsupersede/retractできる

```json
{"id":"R0001","ts":"...","type":"relationship",
 "subject":"S0020","predicate":"requires","object":"evaluator:tests_pass",
 "body":"この能力の完了はテストで判定される",
 "status":"hypothesis","confidence":0.8,
 "conditions":["初期構築フェーズ"],"exceptions":["緊急時"],
 "links":[{"role":"derived_from","to":"S0028"}],
 "provenance":{"source":"decompose-goal","method":"llm"}}
```

- `subject` / `predicate` / `object`: **relationshipでは必須**。端点（subject/object）は
  World Model内のStatement ID、または次の型付き参照:
  `evaluator:<id>` `query:<name>` `golden_task:<id>` `task:<id>` `failure:<id>` `skill:<name>`
  — コアが該当台帳への実在を検証する（**実在しない束縛は書き込めない**）
- `predicate`: vocabulary.yaml登録制（未登録は初出警告、strict時エラー）。初期登録は
  affects / depends_on / requires / causes / contradicts / evaluated_by / measured_by。
  それ以外（enables / prevents / applies_when 等）は需要駆動で追加する
- `conditions[]` / `exceptions[]`: この関係が成立する条件・例外（文字列配列・任意）
- 同一の関係を異なる確信度・証拠で主張する場合は**別Statementとして併存**させ、
  supersedes / counters リンクで淘汰する（confidence 0.61の辺と0.98+証拠の辺は同一視されない）
- CLI糖衣: `autopoiesys relate <subject> <predicate> <object> "<説明>" --source s [--confidence 0.x] [--conditions a,b]`

snapshotには統合辺索引 `indexes.edges_out` / `edges_in`
（relationship辺とlinks辺を `{from, to, kind, via, confidence?, status?}` に統合したビュー）が
構築され、traverse / gap の基盤になる。snapshot metaの `schema_version` が索引形式の版で、
不一致時は自動再生成される。

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
  - where_param: { field: tags, contains: tag }   # paramが与えられた時のみ適用。カンマ区切りはOR（tag=billing,test）
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
`sort` / `project` / `limit` / `traverse`。これ以外はエラー。

`traverse` — 統合辺索引上の決定的BFS。行集合を「起点から到達したノード群」に置き換える:

```yaml
  - traverse: { from_param: root, kinds: [requires, evaluated_by], direction: out, depth: 3, limit: 50 }
```

- `from`（固定ID）または `from_param`（実行時パラメータ）で起点を指定（現在状態に実在必須）
- `kinds`: 辿る辺種の許可リスト（省略時は全種）。`direction`: out | in | both（既定 out）
- `depth`: 最大ホップ数（既定3、上限8）。`limit`: 最大到達ノード数（既定50）
- 各行に `depth` と `path`（経由辺 `{kind, via, from, to}` の列 = Reasoning Path）が付く。
  World Model外の型付き参照に到達した場合は `{id, type: "ref"}` の行になる
- 用途: Reasoning Context生成（CONCEPTv2 §8）。max_tokens強制・query_log記録は他のQueryと同一

出力: `{query, params, count, total, truncated, results[]}`。
概算トークン（文字数/4）が max_tokens を超えると results を切詰め `truncated: true` と
`next_offset` を返す。全実行は observations/query_log.jsonl に記録される。

## Evaluator仕様（evaluators/*.yaml）

共通フィールド: `id` / `method`（deterministic | command | llm_judge）/ `tier`（T0..T3）。
`scope`（任意・文字列）は「このEvaluatorがどのリポジトリで実行されるか」を宣言する。
宣言すると実行ディレクトリは `task.repo_dirs[scope]` に固定され、`evaluate --work-dir` では
上書きされない（横断タスクで一括指定したdirがscope付きEvaluatorを誤った場所で走らせるのを防ぐ）。
scopeが宣言されているのにタスクに対応するdirが無い場合、`task new` は登録時にエラーになり、
評価時に到達した場合は UNCERTAIN（reason: insufficient_evidence）を記録する。

`kind`（任意・`conformance` | `outcome`）は「何を見る評価器か」を宣言する。
`conformance` は規定への適合（枠・語彙・引用・プロセス）、`outcome` は目的の達成
（成果物の外側の効果。例「初見の読者が指定の発見に到達できるか」）を測る。
両者を区別しないと、適合を全通過しながら目的未達の成果物が完成扱いになる。
`autopoiesys check` は、outcome型で裏付けられていない success_criteria を警告する。

共通: `id`, `applies_to`（自由ラベル）, `tier`（T0|T1|T2|T3）, `method`

```yaml
# method: deterministic
id: constraint_check
applies_to: repo_change
tier: T0
method: deterministic
checks:
  - kind: file_exists          # file_exists | file_absent | file_matches | file_not_matches
    path: README.md            # query_empty | query_nonempty | query_matches | query_not_matches
  - kind: file_not_matches
    path: core/store.js
    pattern: "console\\.log"
  - kind: query_empty
    query: find_violations
  - kind: query_matches        # Queryの返却枠に実際にその知識が入るかを内容で検査する。
    query: get_repo_playbook   # 件数だけでは max_tokens の切詰めで重要な1件が落ちても気づけない
    params: { scope: service-api }
    pattern: "npm install"
```

`query_*` は `query`（必須）と `params`（任意）を取り、`query_matches` /
`query_not_matches` は加えて `pattern`（必須）を取る。

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
`reason`（任意）: insufficient_evidence | insufficient_sample | model_limitation |
conflicting_evidence — Next Action Engine が COLLECT_EVIDENCE / COLLECT_EVIDENCE /
DEEP_RESEARCH / RESOLVE_CONFLICT へ写像する。

`insufficient_sample` は `insufficient_evidence` と区別して使う。前者は
**入力そのものが足りず、やり方を変えても現在のデータでは原理的に届かない**状態、
後者は**証拠が集まっていないだけ**の状態である。混ぜると、直しようのないものを
FIX（直せ）と指示し続けることになる。FAILに付けても FIX へは写さないが、
`insufficient_sample` を持たない他のFAILがあればそちらのFIXが優先される
（検出力不足の申告で本物の欠陥を覆い隠さないため）。

`autopoiesys next-action` は、記録から次のシグナルを検出すると `escalation`
（signals / evidence / tier / model / why）を返す。tierは自己申告ではなく
config.yaml の `routing` 表から引く:

| シグナル | 検出条件 | actionへの反映 |
|---|---|---|
| uncertain_verdict | 同一evaluatorのUNCERTAINが2回連続 | DEEP_RESEARCH へ昇格（同じ強さで調べ直しても解けなかった記録） |
| conflicting_evidence | 同一evaluatorの判定が往復（PASS→FAIL→PASS） | RESOLVE_CONFLICT へ。**DONEも上書きする** — 最新のPASSを採ると覆った理由を調べずに完了になる |
| unknown_fingerprint | このタスクの未消化Failureが、対策済みFailureのどれとも症状が一致しない | INVESTIGATE に `escalate: true` |

FIX は昇格で上書きしない（直すべきFAILを覆い隠すと欠陥が視界から消える）。
全PASSのDONEも、conflicting_evidence 以外では上書きしない。

`autopoiesys next-action` は DONE のとき `caveats` を返す: goal.yaml の
success_criteria / constraints のうち、判定器が unbound か実在しない（MISSING）、
または一度も実行されていない（UNVERIFIED）ものの一覧。DONEは「このタスクのevaluatorが
全てPASS」であって「Goalが測れている」ではないため、完了報告に「この目的は現在測定不能」を
明示させるための出力である。

llm_judgeのbriefingには、そのタスクで記録済みのverdict（evaluator・verdict・provenance・
evidence抜粋）が「OSが記録した検証実績」として同梱される。0件の場合はその旨が明記され、
判定者は報告本文の自己申告を証跡として扱わずに済む。

## Task（tasks/tasks.jsonl の1行）

`repo_dirs`（任意）は scope → 作業ディレクトリの対応。横断タスクではEvaluatorごとに
実行先が違うため、単一の `work_dir` では検証先を誤る。CLIは
`task new --repos <scope>[=<dir>],...` で受け取り、`=dir` 省略時は goal.yaml sources の
`repo` を使う。

```json
{"id":"T001","ts":"...","objective":"...","status":"open",
 "artifacts":[{"path":"...","note":"..."}],"evaluators":["tests_pass"],
 "work_dir":"/abs/path/to/worktree","refs":["https://github.com/o/r/issues/1"],
 "context":"...","notes":[{"ts":"...","note":"調査完了: 30分失効をコードで確認"}]}
```

`status` は追記で更新（同idの最新行が現在状態）。
`evaluators`: このタスクに適用するEvaluator ID列。
`work_dir`（任意）: command/deterministic evaluator実行ディレクトリの既定値（`evaluate --work-dir` が上書き）。
`refs` / `context`（任意）: Issue/PR URL等の参照と自由記述の作業文脈。
`artifacts`: llm_judgeが読めるのはここに登録されたファイルだけである。
**実装（ソースコード）を登録せず文書だけを登録すると、判定者は「作業そのもの」ではなく
「作業についての文章」を判定することになり、実装の欠陥はどの評価器も検出できない。**
コアはこの状態を運用ヒントで警告し、briefingにも実装の有無を明記する。
`artifacts[].ts`: 登録時刻。PLANの登録との前後関係を判定するために残す。
`notes`（任意）: `task note` によるチェックポイント列。継続性の正本を会話でなく台帳に置くためのもの。
`plans`（任意）: 事前固定した検証手順（PLAN）のハッシュ履歴。追記専用で上書きしない。

```json
"plans":[{"ts":"2026-08-29T12:00:00Z","path":"PLAN.md","hash":"<sha256hex>"}]
```

`path` は work_dir → repo_dirs → .os の親 の順で解決した相対パス（区切りは `/`）。
`hash` は **BOM除去・CRLF→LF正規化したテキスト**のSHA-256（保存し直しだけで偽の変更警告を
出さないため。`sha256sum` コマンドの値とは一致しない）。
`task plan-verify <id>` が登録時のハッシュと現在のファイルを照合し、
`changed: null` は「照合不能」（ファイルが見つからない）を意味する。
**PLANが変更されたこと自体は違反ではない**（計画の更新は正当でありうる）。
コアが提供するのは「変更された事実」と「その前後関係が記録から判定できるか」だけで、
妥当性は判定しない。llm_judgeのbriefingにはこの照合結果が節として載る。

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
| classified | （`missing_evaluator` と分類すると `proposals/<Fid>-evaluator.yaml` に検出器の提案スタブが自動起票され、遷移イベントに `proposal_stub` が記録される。既存ファイルは上書きしない。適用は upgrade-os の承認制のまま）classification ∈ {missing_knowledge, missing_query, missing_constraint, missing_test, missing_evaluator, bad_workflow, bad_model}（実装部品指向） ∪ {incorrect_knowledge, missing_relation, missing_condition, missing_decision_model, missing_capability, wrong_architecture}（知性構造指向・CONCEPTv2 §9）。任意で refs[]（診断の参照先: StatementID・evaluator:等の型付き参照） |
| upgrade_proposed | proposal（提案内容 or ファイルref） |
| upgrade_proposed → upgrade_proposed | proposal, **supersedes_reason**（前の提案のどこが誤りだったか）。誤った提案を黙って差し替える経路を塞ぐための自己遷移 — 提案を撤回するには、撤回の理由を台帳に残す以外の方法が無い |
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
gap_confidence_floor: 0.7  # gap分析でこれ未満のconfidenceをUNCERTAINに分類する
```

## Intelligence Gap Analysis（`autopoiesys gap`）

goalノードから requires / depends_on 辺で到達するRequired Intelligenceを現在のOSと突合し、
優先順位つき決定表で分類する（保存せず毎回再計算。CONCEPTv2 §6）:

| 順 | 分類 | 判定 |
|---|---|---|
| 1 | CONFLICTING | contradicts辺が接続、または支持と反証のリンクが併存 |
| 2 | MISSING | capability/decisionに束縛辺が無い、または束縛先が全台帳に不在 |
| 3 | STALE | 束縛先がsupersede/retract済み、または最新の支持証拠がstale_after_days超過 |
| 4 | UNVERIFIED | llm由来で証拠ゼロの知識、または束縛evaluatorのverdict記録ゼロ |
| 5 | UNCERTAIN | status=hypothesis（束縛型のcapability/decisionは除く — 可用性は束縛と検証実績で測る）、または confidence < gap_confidence_floor |
| 6 | AVAILABLE | 上記いずれにも該当しない |

goal.yamlのsuccess_criteria/constraints（evaluator接地）も同じ語彙で分類に統合される。
`--assert` はMISSINGを `type: unknown`（tags: [gap]、内容ハッシュ由来idで冪等）として起票する。
`--criteria-only` はgoalノード未整備でもgoal.yamlの接地だけを検査する。

## Token Ledger（observations/costs.jsonl の1行）

```json
{"ts":"...","purpose":"discover-domain","tier":"T3","model":"...",
 "tokens_in":12000,"tokens_out":3000,"estimated":true,"task":"T001","session":"R001",
 "asset_refs":["queries/get_constraints.yaml"]}
```

Skillは全LLM作業（自分自身の推論を含む）をここに自己申告する。
`tokens_in` / `tokens_out` は任意で、入れるなら両方を指定する（片方だけの記録は集計を歪める）。
値は実行者の手入力なので既定で `estimated: true`（見積り）が付き、API実測値を持つ場合だけ
`ledger add --measured` で `estimated: false` になる。分からないなら入れない — 見積りを
実測として台帳に残すと optimization のコスト判断を誤る。
`autopoiesys metrics` が cost/task・tier別消費・cheap-path coverage・切詰め率を集計し、
`tokens.measured` / `tokens.estimated` / `tokens.entries_without_tokens` で内訳を分ける
（`estimated` 未設定の旧エントリは出所不明のため見積り側に数える）。

## Context Log（observations/context_log.jsonl の1行）

```json
{"ts":"...","kind":"briefing","task":"T001","evaluator":"requirement_satisfied","tokens_est":1656}
```

Token Ledgerが実行者の自己申告であるのに対し、こちらは**コアが生成物から直接測った実測値**である。
briefingを書き出すたびに1行追記される（`tokens_est` は生成したbriefing本文の推定トークン数）。
`autopoiesys metrics` の `context.briefing_tokens_total` / `context.query_tokens_total` /
`context.per_task` がこれを集計する。「Reasoning Contextでトークンが減った」という主張は、
自己申告ではなくこの列どうしを比べて検証する。

## Researchセッション（observations/research.jsonl）

```json
{"ts":"...","id":"R001","event":"open","purpose":"..."}
{"ts":"...","id":"R001","event":"close","assets":["evaluators/x.yaml"]}
```

`autopoiesys research close` は assets が空のとき警告する（§14 資産化の出口検査）。
また当該セッションのToken Ledger合計が config.yaml の budgets.research_tokens を
超過している場合も警告する。
