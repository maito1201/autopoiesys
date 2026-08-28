# autopoiesys 設計書

初期構想文書（旧CONCEPT.md — 規範部分は末尾の付録に収録）の「開発エージェントへの最初の指示」に従い、8つの検証項目それぞれについて
採用案・代替案・トレードオフを記す。本設計は独立した3設計案（A: LLM-as-runtime最小主義 /
B: 決定的コア重視 / C: 進化ループ・Token Economics第一）を3名のジャッジ（concept-fidelity /
portability / MVP実現性・進化性の各レンズ）で採点し統合したもの。判定は C勝利2票・B勝利1票。

**統合方針: Cの進化アーキテクチャ（イベントソーシング・知識コンパイル・Token Ledger）を骨格に、
Bの技術基盤（Node.js依存ゼロ・禁止事項のコードパスによる強制）と、Aの監査規約
（briefings・検出力テスト・metrics駆動コンパイル）を移植する。**

---

## 0. 技術選定

**採用: Node.js >= 20 LTS、ランタイム依存ゼロ（`npm install` 不要）。**
唯一のCLIエントリ `cli/index.js` と `core/*.js`（node: 組込みAPIのみ）。

根拠:
- 本プロダクトはLLMエージェント（Claude Code等）ありきであり、Claude Code自体がNodeを
  要求するため「Nodeは確実に存在する唯一のランタイム」。
- Skillが発行するコマンドは `node cli/index.js <subcmd> [--flags]` の1形式のみとし、
  パイプ・リダイレクト・`&&` 等のシェル構文を禁止することで PowerShell / cmd / sh の
  差異を仕様レベルで吸収する。
- 全ファイルI/OはUTF-8・LF固定・キーソート済みJSONで、同一入力→バイト同一出力を保証する
  （回帰テストの基盤）。
- 残る環境差異（エディタ、git設定、対象ドメイン側ツール）の吸収はLLMエージェントの判断に
  委譲する（ユーザー要件で許可済み）。

代替案とトレードオフ:
- **Python 3.10+ stdlib**: sqlite3同梱が魅力だが、Windowsに既定で存在せず
  （Store版python.exeスタブの罠、python/python3/pyの揺れ）、init以前の脱落点になる。
- **Go等の単一バイナリ**: ポータビリティ最強だが、3OS分のリリースパイプラインが必要で、
  未署名バイナリはGatekeeper/SmartScreenに阻まれ「git clone→init」のUXを壊す。
  またエージェントがコアを読んで改善提案する自己改善ループにコンパイル言語は不向き。
- **YAML/TOMLライブラリ依存**: 依存ゼロを守るため、設定・定義ファイルは同梱の
  YAMLサブセットパーサ（core/yaml.js、対応範囲はSCHEMA.mdに明記、範囲外は明示エラー）で扱う。

## 1. Goal Specification の構造

**採用: `.os/goal.yaml`。固定トップレベルキー
（goal / domain / objectives / success_criteria / constraints / autonomy / optimization / sources / notes）。**

核となる判断: `success_criteria[]` と `constraints[]` の各項目は `evaluator` フィールドで
評価器IDに紐付く。**Goal Specは宣言文書ではなく、Evaluator群の発生源**（Cの判断を採用）。
未紐付けの基準は `evaluator: unbound` として明示保持し、`autopoiesys validate` が一覧表示、
Unknown率としてメトリクスに載る。ドメイン固有性はキーではなく値に置く（§23: OSSコアは
抽象概念しか知らない）。ユーザーの自然文はnotesに原文保持し捨てない。

- 代替案: 自由記述のみ（基準が検証不能になり§26③に実質退行）/ 形式DSL・オントロジー
  （§26⑥違反、ドメイン多様性を殺す）/ JSON（人間の編集・レビュー性で劣る）。
- トレードオフ: 固定キーは表現力を縛るが「どの成功基準が未評価か」を機械計算できる。
  キー不足はFailure台帳経由で format_version 更新として扱う。unbound基準が初期に多く残る
  不完全さは受け入れ、Phase 2のEvaluation Model構築を「スタブの充足」に変える。

## 2. World Model の最小データモデル

**採用: 単一の汎用レコード型 Statement のイベントソーシング（Bのモデル + Cの証拠極性）。**

正本は追記専用の `.os/world_model/events.jsonl`。1行 =
`{id, ts, type, body, subject?, predicate?, object?, links[], status, confidence?, tags[], provenance, supersedes?}`

- `type`: §6の12概念に固定 — entity / relationship / observation / claim / evidence /
  hypothesis / unknown / decision / constraint / goal / outcome / failure
- `status`: fact | hypothesis | unknown | retracted — **「事実・仮説・不明の区別」をデータ型で強制**
- `links[]`: `{role, to}`。role = supports | counters | about | derived_from | supersedes |
  relates_to 等。仮説への賛成証拠・反証は supports / counters リンクの極性で表現
- `provenance`: `{source, method, session?}` — 全確信度が観測に遡れる
- 現在状態（supersedes適用済み）と索引（type別・tag別・逆リンク）は `autopoiesys rebuild` が
  `snapshot.json` に決定的に再構成する（正本ではないキャッシュ）
- predicate / tag 語彙は `vocabulary.yaml` 登録制。**初期は警告のみ、実績で安定した語彙から
  strict化する段階運用**（§26⑥「実績から進化」を語彙管理自体に適用）

- 代替案: 型ごとのSQLiteテーブル（語彙進化のたびにマイグレーション、§26⑥に反する。
  node:sqliteは22.5+のみで下限も上がる）/ 純RDFトリプル（confidence・counter_evidenceの
  一級表現を失い「単なるKnowledge Graph」に戻る）/ LLM自由スキーマ（決定的検証・再生が不能）。
- トレードオフ: 汎用レコードは意味論をデータ側に押し出すため語彙ドリフトのリスクがある。
  登録制+lintで抑える。得るものは、ドメインが何であれ同一ストア・同一Queryエンジン・
  マイグレーション不要の進化（§23の直接実装）。イベント10^5件超の再生遅化は増分再生と
  compactionで将来対応（MVPスコープ外と明示）。

## 3. Query Interface

**採用: 宣言的Query定義（`.os/queries/<name>.yaml`）を決定的Queryエンジンが解釈実行する。**

各定義 = `{name, description, params, pipeline, max_tokens, golden?}`。
pipeline は select / where / expand / sort / project / limit のステップ列。
エージェントは `autopoiesys query <name> --param k=v` でJSONスライスを受け取る。

- **max_tokensをコアが強制**（概算トークンで切詰め+継続カーソル）— §26⑤
  「毎回全コンテキスト渡し」を構造的に不可能にする
- OS Builder（build-query-system Skill）の仕事はコードを書くことではなく、この定義を
  設計・追加すること（§7「QueryはOS Builderが領域に応じて設計する」の実装）
- 各Queryは golden 出力fixtureを持てて、Query自体が回帰テスト対象になる（Cのgraft）
- 全実行を query_log.jsonl に記録。**切詰め発生率・実行頻度が閾値を超えたQueryは
  決定的コード（エンジンのステップ追加）への昇格候補として `autopoiesys metrics` が提案する**
  （metrics駆動コンパイル、Aのgraft）
- DSLで書けない需要の逃げ道 = `.os/plugins/`（argv宣言のstdio JSONプロトコル）。
  ただし使用は台帳記録されレビュー対象（決定性崩壊の防止）。
  **注: plugins実行機構はMVPでは未実装**（ディレクトリのみ予約。現状はproposals/還流を使う）

- 代替案: LLMが毎回アドホック検索（§26⑤正面違反・再現性ゼロ・恒常トークンコスト）/
  固定汎用API（§7が明示否定）/ 生成SQL・生成Python実行（表現力最強だが非決定・
  セキュリティ・シェル差異の三重苦。ジャッジのportabilityレンズが最重要減点）。
- トレードオフ: pipeline DSLはチューリング完全なコードより表現力が低く、§7との間に
  「準固定API」の緊張がある。plugin台帳とDSL還流（頻出パターンをエンジンへ追加）で受ける。

## 4. Evaluation Interface

**採用: 宣言的Evaluator仕様 + 決定的Evaluation Runner + 独立実行プロトコル。**

Evaluator = `.os/evaluators/<id>.yaml`
`{id, applies_to, tier, method, ...}`。methodは3種:

1. **deterministic**: ファイル/正規表現/Query結果のアサーション。コアが直接実行
2. **command**: argv配列で宣言（シェル文字列禁止）。exit codeと出力を証拠として捕捉
3. **llm_judge**: Runnerが判定依頼briefing（Artifact + rubric + 指定Queryの出力のみ）を
   ファイルに出力し、**新規サブエージェント**が判定して `autopoiesys verdict --file` で記録。
   生成側エージェントの会話履歴は一切渡さない（§26③の実行形態による強制、Aのgraft）

verdict = `{task, evaluator, verdict: PASS|FAIL|UNCERTAIN, evidence[], provenance, tier}` を
evaluations/log.jsonl に追記。**決定的評価のFAILはLLM判定で覆せない**（Bのgraft）。
provenance刻印により回帰テストではllm_judgeを記録済み判定のリプレイに置換できる。

Next Action Engine（`autopoiesys next-action <task>`）が§11の決定表を引く:
PASS→DONE / FAIL→FIX / UNCERTAIN→INVESTIGATE / 証拠不足→COLLECT_EVIDENCE /
モデル限界→DEEP_RESEARCH / 矛盾→RESOLVE_CONFLICT。
**Agentの「完了しました」はどのコードパスでも使われない（§26③）。**
DONEには `caveats`（判定器が無い・一度も実行されていない success_criteria / constraints）が
添えられる。**DONEは「このタスクのevaluatorが全てPASS」であって「Goalが測れている」ではない**ため、
測れていない目的を完了報告の中で沈黙させない。

Agentがそもそもevaluateを呼ばずに完了報告する経路は、決定的な運用ヒント
（`maintenanceHints`: 未評価のまま開いているタスクを警告として出す）で塞ぐ。
task new / task artifact / evaluate / next-action / feedback / ledger add の出力に載り、
Skillはこれを省略せず中継する義務を負う。

- 代替案: エージェント自己申告（§26③で明示禁止）/ 全件LLM判定（非決定・高コスト・
  回帰の再現性喪失）/ 全件決定的（曖昧な基準を扱えずカバレッジの穴が沈黙。UNCERTAIN+
  エスカレーションで扱う方が§11と整合）。
- トレードオフ: 3値verdict+3種実装+独立プロセスは単純なassertより複雑だが、Next Action
  Engineに信頼できる入力を与える唯一の構成。UNCERTAINこそがRouting昇格のトリガーであり、
  deterministic化されたEvaluator比率（cheap-path coverage）を一級指標としてPhase 5への
  進捗を初日から可視化する。

## 5. Failure → OS Upgrade のデータフロー

**採用: failures/ledger.jsonl を正本とする状態機械をコアが強制（Bのgraft）+
fingerprint照合によるcheap経路（C）+ 検出力テスト（A）。**

```
reported ──(既知fingerprint一致→既存Prevention適用で終了)──┐
   │ 未知                                                   │
   ▼                                                        ▼
investigated (root_cause, why_undetected 必須)          （終了）
   ▼
classified (missing_knowledge|missing_query|missing_constraint|
            missing_test|missing_evaluator|bad_workflow|bad_model)  ← §12をenumに
   ▼
upgrade_proposed (提案 = 新rule/query/evaluator/golden_task/Skill改訂のdiff集合、ユーザー承認ゲート)
   ▼
implemented (assets必須: 最低1 golden_task + 1 検出系資産。regression実行済みが遷移条件)
   または accepted_risk (理由必須)
```

- `autopoiesys failure lint`: 非終端のまま滞留したFailureを検出し**regressionを不合格にする**
  — §26④「ログとして保存して終わる」を機械的に不可能にする
- `why_undetected` フィールド必須 — §26⑦「なぜOSはこの失敗を許したのか」が全レコードに残る
- **検出力テスト**: Failure由来のgolden_taskは既知の悪い状態のfixtureを持ち、検出器が
  それに対して実際にFAILを出すことをregressionで検証（ダミー成果物によるlint形骸化の防止）
- ユーザーの「この結果は駄目」一言 = `autopoiesys feedback "<text>"` がreported起票+fingerprint照合

- 代替案: 自由記述ポストモーテム（Detection/Preventionを強制できない=§26④違反そのもの）/
  提案なし自動適用（承認ゲート喪失、自己改悪ループ）/ 外部Issueトラッカー（オフライン不能・
  構造化喪失）。
- トレードオフ: 状態機械は些細な失敗には官僚的。severity: low の短縮経路（週次バッチ調査）を
  許すが、why_undetected だけは省略不可。1件ごとのhigh-end調査コストはfingerprint照合で
  既知Failureをcheap経路に落とすことで逓減させる（失敗処理コスト自体がToken Economicsの縮図）。

## 6. ユーザー固有OSとOSS Coreの境界

**採用: OSS Core = エンジン（cli/ + core/）+ Skill群 + スキーマ + テンプレート。
ユーザーOS = ワークスペースの `.os/` で、純粋なデータ（YAML/JSONL + 宣言的定義）のみ。**

- 契約は2点のみ: (1) `.os/` のオンディスク形式（config.yaml の format_version で版管理、
  SCHEMA.mdに明記）、(2) CLIサブコマンド群
- 生成されたOSはコードを含まない。Query/Evaluator/Ruleは全てコアの解釈器が実行する
  宣言データ。例外は明示マーク付き `.os/plugins/` のみ（使用台帳記録）
- Coreは `.os/` の外に書かない。Core更新はユーザーデータに触れない（移行は明示的
  `autopoiesys migrate`）。upgrade-osがOSS Core自体の欠陥を発見した場合は `.os/proposals/` に
  PR下書きを出力するだけで無断編集しない
- `.os/` はOSS repoから物理分離（本repoでは .gitignore 対象）。ユーザー自身のgit repoとして
  独立に履歴管理・バックアップ・別マシン移行できる（§22の完全分離）
- 設計原則§21 の `os/generated/`（OSS repo内混在）は採らず、§22の `.os/` 分離を正とする

- 代替案: OSS repo内に生成物混在（ユーザーの機密ドメイン知識がOSS作業ツリーに混入、
  git pull更新も汚染）/ fork-per-user（upstream更新が取り込めず進化が分岐）/
  ユーザーOSを生成コードベースとして出力（Core更新のたびに互換性が壊れ、監査可能性喪失）。
- トレードオフ: データ・オンリーのユーザーOSは実行能力の拡張を解釈器（OSS Core）の成長に
  依存させる。個別ユーザーには遅いが、新機構がOSSへ還流してエコシステム全体で複利になり、
  全ユーザーのOSがCore更新後も動き続ける。

## 7. LLM token消費を最小化するArchitecture

**採用: 4機構の組合せ（C）+ briefings規約（A）+ research closeゲート（B）。**

1. **Token Ledger**: 全LLM呼び出しをSkillが `autopoiesys ledger add` で
   `{purpose, tier, model, tokens_in/out, task, asset_refs}` として自己申告記録。
   cost/task と cheap-path coverage を一級メトリクスとしてPhase 1から計測
2. **Routing表**: config.yaml に T0(決定的)/T1(cheap)/T2(mid)/T3(high-end) の宣言と
   昇格条件（UNCERTAIN verdict・anomaly・未知fingerprint・矛盾・OS再設計のみ）。
   既定経路は T0→T1。**T3呼び出しは必ず `.os/briefings/` に厳選コンテキストを編纂して
   から投入し、会話履歴全量を渡さない**（何を渡したかがgit監査可能になる）
3. **知識コンパイル**: T3の出力は自由散文を禁止し構造化findings
   （claims / rule候補 / query候補 / evaluator候補 / golden_task候補）に限定。
   `autopoiesys compile --file` が資産へ変換する。**Deep Researchセッションは
   `autopoiesys research close` 時に資産を1つも産出していなければ警告**（§14の資産化を
   入口=出力形式と出口=産出物検査の両側から強制）
4. **コンテキスト規律**: エージェントへの入力は名前付きQueryの結果のみで構成。
   World Model全体やイベントログ生渡しの経路をCLIレベルで作らない（§26①⑤）

- 代替案: プロンプトキャッシュ依存（仕事量自体が減らずベンダー固定化）/ 埋め込みRAG中心
  （§26②接触・非ポータブル・監査不能）/ 小型モデルfine-tuning（Phase 5以降の蒸留先で
  あって最初の手段ではない）。
- トレードオフ: 決定的な異常ゲートは微妙に新奇なイベントを見逃す（偽陰性）。UNCERTAIN
  昇格による事後捕捉の二段構え = 初回失敗のコストを許容する設計。Skillの規律逸脱
  （.os/直編集等）は完全防止できないため、`autopoiesys check` の整合検査と契約超過のmetrics警告で
  検出に寄せる。

## 8. 最小MVPで実際にEnd-to-End動作させる方法

**採用: 垂直スライス（Phase 1〜3の全段を各1機能ずつ貫通）× 自己ホスト
（autopoiesysリポジトリ自身を対象にしたEngineer OS）。**

水平（Phase 1のみ完全実装）を採らない理由: 閉ループが一周しないMVPは、このプロダクトの
中核仮説「推論の資産化でコストが逓減する」を何も検証しない（Cの判断、ジャッジ2名が支持）。

デモシナリオ（追加データ不要、cloneした誰でも再現可能）:

1. `node cli/index.js doctor` — 環境診断（ここが通れば以降の全コマンドが動く）
2. `/init-os` — 動的ヒアリング（最大5問）→ goal.yaml → `autopoiesys validate`（unbound基準の可視化）
3. `/discover-domain` — `autopoiesys ingest repo`（決定的・LLMゼロ）+ Research（T3・briefing経由・
   構造化findings）→ `autopoiesys compile` → World Model
4. `/build-query-system` `/build-evaluation-model` — Query 3本 + Evaluator 3本を宣言的に生成
5. `/run-task` — 小タスク1件。文脈はQuery経由のみ（T0→T1/T2）→ Artifact
6. `autopoiesys evaluate` — 独立評価 → verdict + evidence → `autopoiesys next-action` が DONE/FIX/INVESTIGATE
7. `autopoiesys feedback "この結果は駄目だった"` — Failure起票 → `/investigate-failure`（T3）→
   rootcause + why_undetected → upgrade提案（新detector + 新golden_task）→ ユーザー承認 → 適用
8. `autopoiesys regression` — golden_tasks全件 + 検出力テスト + failure lint
9. 同一タスク再実行 → 新detectorがT0で事前検出、`autopoiesys metrics` で tokens/task の逓減を実証

成功判定: (a) 再実行がT3不使用で完了 (b) tokens/taskが初回比で減少 (c) 全状態変化が
git diffで監査可能 (d) 全verdictにevidence refsが付く。

CI（将来）: LLM応答を事前記録fixtureに置換したヘッドレス再生を
windows / macos / ubuntu の3OSマトリクスで実行し、同一入力→バイト同一出力を検証する。

- 代替案: Phase 1のみ（資産フォーマットが後付けになりPhase 3でデータ作り直し）/
  最初から全Skill・マルチエージェント編成（検証が遅れMVPの意味を失う）/
  外部サンプルrepo同梱（自己適用の方が追加データ不要で検証が速い。ユーザー決定済み）。
- トレードオフ: 自己ホストはBuilderと対象が同一領域（software engineering）になるため
  コアがEngineer OSに過適合するリスク。Phase 2で非エンジニア領域（例: KPI監視のミニ
  経営OS）の差し替えテストを汎用性の回帰テストとして必須にする。

---

## §26 禁止設計への対応表

| 禁止 | 対応する構造 |
|---|---|
| ① 巨大System Promptに知識詰め込み | 知識は全てStatement化、注入はQuery経由のみ。Skillは手順のみ保持 |
| ② RAGだけで解決 | 検索でなくStatement（status/confidence/links極性）+ Decision + Failureの構造化状態 |
| ③ Agent自己完了判定 | verdictを出せるのは `autopoiesys evaluate`（独立実行プロトコル）のみ。決定的FAILはLLMで覆せない |
| ④ Failureのログ死蔵 | 状態機械 + failure lint（非終端滞留でregression不合格）+ implemented遷移にassets必須 |
| ⑤ 毎回高性能LLMに全コンテキスト | Queryのmax_tokens強制 + briefings規約 + Routing表 + Token Ledger監視 |
| ⑥ 最初から完璧なOntology | 単一Statement型 + スキーマレスbody + 語彙登録制の段階strict化 + format_version |
| ⑦ OS Upgradeの局所修正 | why_undetected必須 + classification enum + 検出力テスト |

## Skill構成（MVP: 8個に統合、分割は実需要から — §26⑥をSkill構成にも適用）

| Skill | 役割 | 主tier |
|---|---|---|
| init-os | doctor → 動的ヒアリング → goal.yaml → .os/ scaffold | T2 |
| discover-domain | 対象領域Research → 構造化findings → compile | T3許可 |
| build-query-system | Query定義の設計・生成・golden添付 | T2 |
| build-evaluation-model | Evaluator仕様の設計・生成 | T2 |
| run-task | Objective→Plan→Execute→Evaluate→Next Actionループ | T0-T2 |
| evaluate-artifact | 独立評価プロトコル（新規サブエージェント・briefingのみ） | T1-T2 |
| investigate-failure | 状態機械の遷移充足・root cause・upgrade提案 | T3許可 |
| upgrade-os | 提案適用 → regression → バージョン付与 / rollback | T0-T2 |

Skillの正本は `skills/<name>/SKILL.md`。Claude Codeへの公開は `.claude/skills/<name>/SKILL.md`
の薄いスタブ（正本を読んで従えという1行）で行い、二重管理を避ける。

## リポジトリ構造

```
autopoiesys/                  # OSS Core（ドメイン知識ゼロ）
├── README.md
├── SCHEMA.md                 # .os/ オンディスク形式契約（format_version管理）
├── docs/DESIGN.md            # 本書
├── package.json              # メタデータのみ（dependencies: {} を維持）
├── cli/index.js                # 唯一のCLIエントリ
├── core/                     # 決定的コア（node:組込みのみ、LLM呼出ゼロ）
├── skills/<name>/SKILL.md    # Agent Skill正本（8個）
├── .claude/skills/           # Claude Code公開用スタブ
├── templates/                # .os/ 雛形
└── tests/                    # node --test（コア単体 + ヘッドレスE2E）

<ユーザーワークスペース>/.os/   # ユーザー固有OS（initが生成、OSS repoでは.gitignore）
├── goal.yaml  config.yaml
├── world_model/{events.jsonl, snapshot.json, vocabulary.yaml}
├── queries/*.yaml  evaluators/*.yaml  rules/*.yaml
├── tasks/tasks.jsonl  evaluations/log.jsonl
├── failures/ledger.jsonl  golden_tasks/*.yaml
├── briefings/  proposals/  plugins/
└── observations/{costs.jsonl, query_log.jsonl, research.jsonl}
```

## 主要リスクと緩和

1. **宣言的DSLの表現力不足**（本設計最大の賭け）: plugin使用の台帳記録+レビュー、
   頻出パターンのエンジン還流、切詰め率のmetrics監視で受ける
2. **llm_judgeの非決定性**: provenance刻印、決定的FAIL優先、回帰でのリプレイ置換
3. **Skillの規律逸脱**（.os/直編集・全読み）: 完全防止は不能。`autopoiesys check` 整合検査と
   metrics警告で検出に寄せ、独立評価で汚染を遮断
4. **JSONLスケール限界**: 10^5件超で増分再生+compaction（MVPスコープ外と明示）
5. **自己ホストMVPの過適合**: Phase 2で非エンジニア領域の差し替えテストを必須関門に
6. **並行書込み**: MVPは単一セッション単一ライター規約。gitを衝突検出器として使う

---

## 付録: 設計原則（旧CONCEPT.mdの章番号対応）

本リポジトリのコード・スキル・ドキュメントに現れる「設計原則§n」という引用は、
初期構想文書CONCEPT.md（役目を終えて削除済み）の章番号である。引用の解決先として、
規範として効いている部分を以下に収録する。

### §1 最重要コンセプト

目的はLLMに大量のコンテキストを与えて賢く振る舞わせることではなく、高性能LLMの推論を
再利用可能な構造・ルール・評価器・Query・Workflowへ変換し、目的領域固有の知性を
蓄積すること。`LLM = Intelligence generator / OS = Accumulated intelligence + 実行環境`。
日常業務では高価なLLMを使わず、未知の問題・重大な失敗・モデル限界の検出時のみ
Deep Researchを実行する。

### §6 World Model

単なるKnowledge Graphにしない。世界について「何が事実で、何が仮説で、何が不明か」を
区別し、Hypothesis・Evidence・反証・Confidence・関連Decision・過去Failureまで保持する。

### §7 Query System

World ModelをLLMに丸ごと渡さない。Queryは固定APIではなく、OS Builderが対象領域に
応じて設計するもの。

### §9-10 Evaluation / 「完了」の定義

Agent自身の「完了しました」を信用しない。評価は独立に
Artifact → Expected state → Evidence → Evaluation → PASS/FAIL/UNCERTAIN で行い、
**Agentは仕事を実行するが、完了を認定するのはOS**。

### §11 Next Action Engine

評価結果から次の行動を決定する:
PASS→DONE / FAIL→FIX / UNCERTAIN→INVESTIGATE / 証拠不足→COLLECT_EVIDENCE /
モデル限界→DEEP_RESEARCH / 矛盾する証拠→RESOLVE_CONFLICT。
DONEには接地していない成功基準がcaveatsとして添えられる（測れていないことを黙らせない）。

### §12 Failure Learning

OSの最大の資産は失敗。全失敗を Root Cause →「なぜ検出できなかったか」→
何が欠けていたか（Knowledge / Query / Constraint / Test / Evaluator / Workflow / Model）
まで分析し、OS Upgradeへ変換する。

### §13 Failureから検出器を生成する

失敗パターンを知識として保存して終わらせず、Detection / Prevention 戦略へ変換し、
可能な限り安価な検出器（static analysis・lintルール・テスト・query・monitor・小型モデル）
へコンパイルする。

### §14 Token Economics

高性能LLMの推論を raw reasoning のまま保存しない。knowledge → rule → query →
evaluator → procedure へ変換し、将来の推論コストを減らす。理想は
「初期: 高コスト推論が支配的 → 成熟後: 安価なランタイム＋少量の高コスト研究」。

### §15 LLM Routing

モデルを一種類に固定しない。Deterministic tools → Cheap → Mid → High-end の階層を持ち、
High-endは未知の問題・重大な失敗・矛盾・高リスク意思決定・OS再設計のみに使う。

### §16-17 OS Upgrade / Regression

ユーザーの不満から、期待結果の再構成 → 実際との比較 → root cause → 系統的失敗の特定 →
OS変更提案 → 実装 → 回帰評価まで自律実行する。重要ケースはGolden Taskとして保存し、
OS更新のたびに全件で回帰評価する。

### §18 OS Quality Metrics

最重要指標は「人間が介入しなかった場合でも、最終状態が人間自身が仕事をした場合以上に
なったか」。Human Intervention Rate・Cost/Task・Token消費・回帰率等を測定する。

### §19 Self-Improvement Loop

毎回Deep Researchしない。通常の更新は event → 決定的更新。未知は anomaly → 調査 →
高性能LLM。重大な失敗は 高性能LLM → OS Upgrade。

### §20-23 構成と分離

OS BuilderはAgent Skill群として実装する（§20）。ユーザー固有OSは `.os/` に生成し、
OSS本体と完全分離する（§21-22）。OSSコアは「何のOSを作るか」を知らず、
Goal / World / Decision / Evidence / Evaluation / Failure / Learning / Action という
抽象概念だけを扱う — Engineer OSも経営OSも同じエンジンで構築できる（§23）。

### §26 絶対に避ける設計（禁止7項）

1. **巨大なSystem Promptに領域知識を詰め込む** — 知識はWorld ModelとQueryに分離する
2. **RAGだけで解決する** — 検索結果を渡すだけでなく、状態・仮説・Evidence・Decision・
   Failureを構造化する
3. **Agent自身に完了判定させる** — 独立したEvaluationを必須とする
4. **Failureをログとして保存して終わる** — 必ずDetection / Prevention / OS Upgradeまで
   検討する
5. **毎回高性能LLMに全コンテキストを渡す** — Incremental Update・Targeted Query・
   Model Routingを使用する
6. **最初から完璧なOntologyを作る** — 実際のQuery需要・Failure・Decisionから進化させる
7. **OS Upgradeを局所修正で終わらせる** — 「なぜOSはこの失敗を許したのか」まで遡る
