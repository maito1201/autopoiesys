# Intelligence Graph 設計書 — CONCEPTv2 手順1〜4の成果

[CONCEPTv2.md](../CONCEPTv2.md) の開発順序に従い、手順1（Knowledge構造の確認）・
手順2（Failure/Evaluation構造の確認）・手順3（Relation不在で不可能な推論の列挙）・
手順4（最小データモデル設計）の結果を記す。実装（手順5-6）と実験（手順7-9）はこの設計に従う。

**最上位原則の再確認**: 「Relationが最大のボトルネック」は仮説であり、本設計はその検証装置を
作るものである。設計自体もこの仮説に賭けすぎない形（完全に追加的・巻き戻し可能）を取る。

---

## 1. 現状確認の要約（手順1-2）

### 1.1 Relation機構は既に「2系統」ある

| 系統 | 実体 | 持っているもの | 欠けているもの |
|---|---|---|---|
| A: `links[]` | Statement埋め込みの `{role, to}` | 参照整合検査・links_in索引・expandで走査可能 | 属性が2つだけ。固有id・confidence・evidence・conditions無し。リンク単体のsupersede不可 |
| B: `type: relationship` + subject/predicate/object | 独立したStatement | 固有id・ts・provenance・confidence・status・supersedes・証拠リンク — CONCEPTv2 §4の9属性中7つを既に充足。predicateは登録制の開放語彙 | **死蔵状態**: 実使用0件・s/oの実在検証なし・索引なし・expandが辿らない・CLI導線なし |

**結論: 第一級Relationへの最短路は新グラフ層の追築ではなく、死蔵系統Bの蘇生である。**
不足はconditions/exceptionsの2属性と、実在検証・索引・走査・導線のみ。

### 1.2 Failure/Evaluation構造の所見

- 状態機械の骨格（why_undetected必須・assets強制・検出力テスト・failure lint）はCONCEPTv2 §9と
  完全に整合しており、維持する
- ただし現行の分類enumは「OSのどの部品ファイルが欠けたか」（query/test/evaluator/workflow）という
  **実装部品指向**で、§2/§9が要求する「どの知性の層が欠けたか」（knowledge/relation/decision model/
  capability/architecture）という**知性構造指向**と軸が異なる
- **最大の構造的欠落はDecisionの不在**: 評価はtaskの成果物を判定し、失敗はsymptomから遡るが、
  その間にあった「判断」がどこにも記録されない。Incorrect Decision / Decision Model不足は
  診断の参照先を持ち得ない
- verdict→Statement、Failure→Statement、goal.yaml→World Modelの接続は散文と命名規約のみ。
  台帳横断リンクはlinksの実在検査がWorld Model内に閉じているため書けない

## 2. 現在答えられない問い（手順3）— 原因の公平判定

実際の `.os/` データに即した10例。**主因の判定はRelation決め打ちにしていない。**

| # | 答えられない問い | 主因 | severity |
|---|---|---|---|
| 1 | sc-003（unbound）の接地には何が必要で何が欠けるか | **Goal分解不在**＋Goalのノード化不在 | high |
| 2 | F001とF003に共通する根本条件はあるか（同じ穴の横断集約） | **Relation不在**（受け皿のexpand caused_byまで実装済みでリンクだけ無い） | high |
| 3 | F001の予防資産はどの制約を守るためか／資産を持たない制約はどれか | **Relation不在**＋evaluator等のノード化不在（半々） | medium |
| 4 | 制約c-002の適用条件・新規ファイルへの追随 | 条件の構造化不在（evaluatorのglob対応という単純な未実装でも塞がる） | medium |
| 5 | 仮説S0004への支持/矛盾証拠と確信度の更新 | **運用ループ不在**（Relation型は定義済み。張る手続きと更新手続きが無い） | medium |
| 6 | Unknown S0005はどの判断をブロックしているか | **Decision Model不在**（ブロック先のDecisionノードが0件。Relation型だけ足しても空リンク） | medium |
| 7 | タスクの判断に必要な最小知識サブセット（§8 Reasoning Context） | **Traversal不在**＋ノード化不在＋Relation不在の3つ全部 | high |
| 8 | 失敗原因はKnowledge/Relation/Decision Model/Evaluation/構造のどれか（§2成功条件） | **分類語彙と診断手続きの不在**（enumの問題。Relationはその1分類にすぎない） | high |
| 9 | GoalへのAVAILABLE/MISSING一覧（§6 Gap Analysis） | **Goal分解不在**（Capability概念がどこにも無い。比較の両辺が未構造化） | high |
| 10 | fact S0003は今も真か・いつ何が検証したか（STALE判定） | **Relation不在**（verdict→Statementリンク）＋verdictのノード化不在 | low |

**集計**: 主因がRelation不在と言えるのは3件（#2, #3, #10）。Goal分解・ノード化の不在が4件
（#1, #7, #9, ＋#6のDecision不在）、分類語彙・運用・単純未実装が3件。

**手順3の結論**: 実データは「Relationは必要条件の一つだが、単独のボトルネックではない」ことを
示す。CONCEPTv2 §19が予告した優先順位（Goal Decomposition → Gap Analysis を先に、Relation
巨大化を後に）を、着手前の現状分析が支持した。よって実装順は
**①ノード化+Relation蘇生（最小）→ ②Goal分解+Gap Analysis → ③Traversal/Reasoning Context**
とし、Relation型の拡充は実験（手順7）の需要駆動とする。

## 3. 最小データモデル（手順4）

### 3.1 ノード = 既存Statement（新レコード種別なし）

- **追加は `capability` 1型のみ**（STATEMENT_TYPESへの追加的変更。migration不要）。
  §5のGoal分解の受け皿・Gap分析の分類単位として立ち上げに必須なため
- CONCEPTv2 §3の16型との対応: 9型は既存typeが直接対応（Fact=claim/observation＋status:fact）。
  Condition は当面Relation側の`conditions[]`属性（独立ノード需要が出たら`condition`型を追加）。
  Metric はKPI実験開始時に追加
- **World Model外の正本台帳（Action=tasks / Evaluation=evaluators+verdicts / Procedure・Skill=skills/）
  は複製ノード化しない**。Relationの端点に typed asset ref（`evaluator:tests_pass` /
  `query:get_constraints` / `task:T001` / `failure:F001` / `skill:run-task`）を許し、
  コアが該当台帳への実在検証を行う — 二重管理を避けつつ台帳横断リンクを可能にする

### 3.2 Relation = `type: relationship` Statementの昇格（新ファイル・新ID空間なし）

§4必須9属性の写像: source=`subject` / type=`predicate` / target=`object` /
confidence=既存`confidence` / evidence=既存links機構（supports/counters — 極性つきで
フラット配列より§6要求に適合）/ **conditions=新設`conditions[]`** /
**exceptions=新設`exceptions[]`** / created_by=既存`provenance` / created_at=既存`ts`。

```json
{"id":"S0031","type":"relationship","subject":"S0020","predicate":"requires",
 "object":"evaluator:kpi_signal_quality","body":"KPI設計には経営Decisionの特定が先行必要",
 "status":"hypothesis","confidence":0.7,"conditions":["初期構築フェーズ"],
 "links":[{"role":"derived_from","to":"S0028"}],
 "provenance":{"source":"decompose-goal","method":"llm"}}
```

- validateStatementに追加: relationshipはs/p/o必須、subject/objectはWorld Model内IDまたは
  typed asset refとして実在検証（**LLMは辺を提案できるが、捏造された束縛は書き込めない**）
- 同一の辺を confidence 0.61 と 0.98+evidence で区別する要求（§4）は、別Statementとして併存し
  supersedes/countersで淘汰される形で自然に満たされる
- **predicate最小集合（19種中6種のみ登録）**: `requires` `depends_on` `causes` `contradicts`
  `evaluated_by` `measured_by`。各語が立ち上げ機能の具体的な消費者を持つ（分解の骨格辺2・
  Gap束縛辺2・CONFLICTING入力1・§4旗艦例1）。残り13種は既存の「未登録は警告→実績で登録」
  フローで需要駆動追加（§26⑥）
- **二層の役割分担**: links[]は「Statementについての軽量配管」（証拠極性・由来）として現状維持。
  confidence/conditionsを要する領域知識の辺だけをrelationshipに昇格させる。既存イベントは全て無変更で有効

### 3.3 Traversal / Subgraph / Reasoning Path = Queryエンジンの拡張

- snapshotに統合辺索引 `indexes.edges` を追加（relationship + links[]を単一の辺ビューに統合、
  from/to両方向）。**前提条件: snapshot metaに schema_version を追加し、コア更新時の強制再生成を
  保証する**（現在はevents checksumのみで、旧snapshotが有効判定される沈黙バグの芽）
- PIPELINE_STEPSに `traverse` を1語追加:
  `traverse: {from_param: root, kinds: [...], direction, depth, limit}` — visited集合＋深さ上限＋
  idソートの決定的BFS。各行にpath（経由辺id列）を付与 = Reasoning Pathの実体
- Subgraph抽出はコードでなく**Query定義として**実装（例: `queries/reasoning_context.yaml`）。
  これにより§8の最小Reasoning Contextが、既存のmax_tokens強制・query_log記録・golden回帰・
  llm_judgeのcontext_queriesにそのまま乗る
- 専用コマンドにしない理由: Queryエンジン外の第二のトラバーサル経路はmax_tokens/query_logを
  迂回するコンテキスト取得路になり設計原則§26⑤に反する

### 3.4 Goal → Required Intelligence → Gap Analysis

**境界の原則: 意味の提案はLLM、実在と健全性の判定は決定的コア**
（`evaluator: unbound`パターンとcompileの散文拒否の一般化）。

1. **分解（LLM・新skill decompose-goal）**: goal.yaml＋有界Query結果を入力に、capabilityノード群と
   requires/depends_on/evaluated_by/measured_by辺を構造化findingsで出力 → 既存`compile`で接地
2. **分類（決定的・新コマンド `autopoiesys gap --goal <id>`）**: goalノードからrequires/depends_on辺を
   traverseし、到達ノードを snapshot＋evaluators/＋queries/＋verdicts＋failures と突合。
   優先順位つき決定表:

   | 順 | 分類 | 判定 |
   |---|---|---|
   | 1 | CONFLICTING | supports/counters併存 or contradicts辺が接続 |
   | 2 | MISSING | 束縛辺なし or 束縛先が全台帳に不在 |
   | 3 | STALE | 束縛先がsupersede/retract済み or 最新証拠がstale_after_days超過 |
   | 4 | UNVERIFIED | 証拠ゼロのllm由来 or evaluatorはあるがverdict記録ゼロ |
   | 5 | UNCERTAIN | status=hypothesis or confidence < gap_confidence_floor（config新キー、既定0.7） |
   | 6 | AVAILABLE | 上記いずれでもない |

3. 分類結果は**保存せず毎回再計算**（保存した瞬間それ自体がSTALE化する）。
   `--assert`オプションでMISSING項目をtype:unknownとして起票 → §13のUnknown第一級化と
   Next Action提案（Research/Experiment/Human Decision）に接続
4. §6の核心「Knowledge不足とDecision Model不足の区別」は、requiredノードのtype
   （claim/decision/capability）× 束縛先の種別（statement/evaluator ref）の組で機械的に表現される
5. **Failure診断との接続（§9）**: classificationに知性層指向の値
   （missing_relation / missing_decision_model / missing_capability / wrong_architecture）を追加し、
   診断の参照先ID（どのstatement/evaluator/relationが問題か）を持たせる

### 3.5 検討した代替案

- **A案: links[]拡張**（各linkにconfidence等を持たせる）— 却下。Relation追加・訂正のたびに
  ノード本体のsupersedeが必要で履歴が汚れる。辺の独立retract不可。実質ミニStatementの再発明
- **B案: 独立relations.jsonl新設** — 却下。ID空間・冪等assert・supersede・lint・snapshot・
  Query・語彙管理の全機構を二重化し、既定義のreified relationと恒久並立する。
  「既存閉ループを壊さない」制約に最も反する
- **C案（採用）: 既存2系統の役割分担**。新ストアゼロ・新フィールド2つ・enum追加1つで§4を充足

## 4. 実装計画（手順5-6）と変更面積

| 変更 | ファイル | 種別 |
|---|---|---|
| capability型・relationship検証・conditions/exceptions・typed asset ref検証 | core/store.js | 追加的 |
| edges索引・snapshot schema_version | core/store.js | 追加的（snapshot再生成のみ） |
| traverseステップ | core/query.js | 追加的 |
| gapコマンド（決定表・cross-store突合） | core/gap.js（新規）+ cli | 新規 |
| classification拡張（知性層指向の値+参照先ID） | core/failure.js | 追加的（既存値は維持） |
| predicate 6種登録・gap_confidence_floor | scaffold/config雛形 | 追加的 |
| decompose-goal skill | skills/（新規） | 新規 |
| relation起票の対話導線 | cli（assert拡張 or relateコマンド） | 追加的 |
| SCHEMA.md（relationship節・traverse・gap・format_version 0.2.0） | docs | 更新 |

すべて追加的でmigration不要。Relation仮説が棄却された場合、辺はretractで巻き戻り、
World Model本体は無傷（§10のBaseline比較を同一OS上で実行できる根拠）。

## 5. A/B実験の骨子（手順7-8）

> **2026-08-28更新: 手順7（KPI Dashboard実験）はユーザー判断でスキップ**（実現性が低い）。
> 代替として、Success 1-5は自己適用Engineer OS上の実データで小規模に検証する
> （結果は§5.1に追記）。**Success 6（人間が後から指摘する欠陥の事前発見）は未検証のまま残る** —
> 高度な実務での価値検証は、実運用の中で機会があれば行う。以下の設計は参考として残す。

### 5.1 自己適用OSでの検証結果（2026-08-28）

autopoiesys開発用Engineer OS（`.os/`）の実データで実施:

| 成功条件 | 結果 |
|---|---|
| S1: Goal→Required Intelligence導出 | **成立**。goal-engから7 capabilityを導出し、5つを既存資産（evaluator 4・query 2・golden_task 1）に束縛。実在しない束縛はコアが拒否することも確認 |
| S2: 保有/不足の区別 | **成立**。gap分類: AVAILABLE 11 / MISSING 3 / UNVERIFIED 1。特に cap-change-risk（変更リスク評価）が「知識不足でなく束縛不足＝構造不足」としてMISSINGに出た — §6の核心の区別が実データで機能 |
| S3: Relationで単体では得られない判断 | **成立**。手順3の「答えられない問い#2」（F001とF003は同根か）が、cond-sc3-unbound --causes--> failure:F001 / failure:F003 の辺により、LLMゼロ（T0）のfailure_causesクエリで機械的に答えられるようになった |
| S4: 知識不足と知性構造不足の区別 | **機構は成立**（classification 6値追加＋refs、テスト済み）。実際の失敗での運用実績は次のFailure発生を待つ |
| S5: Context削減とDecision Quality | **部分成立**。traverseによるReasoning Contextは3行・百数十トークンの最小サブグラフを返し、query_logで計測可能。ただし品質向上の実証にはタスク数が必要（未完） |
| S6: 人間指摘の事前発見 | **未検証**（手順7スキップにより。実運用で機会があれば） |

発見された設計調整: capability/decisionの可用性はノード自身のstatus（hypothesis）ではなく
束縛と検証実績で測るべき — 当初の決定表ではLLM分解由来の全capabilityがUNCERTAINに潰れて
信号が濁った。UNCERTAIN判定から束縛型ノードのstatus条件を除外して解消（テスト追加済み）。

**手順9（Relationは本当にボトルネックだったか）の暫定回答**: 手順3の事前分析どおり、
Relation単独ではなく「ノード化（goal/capability/台帳参照）＋Relation＋Gap分類」の三点セットで
初めて§2の問いに答えられるようになった。Relationは必要条件だが、価値の過半は
Goal分解とGap分類（決定表）が生んでいる — CONCEPTv2 §19の予告と整合。

- 同一Goal・同一タスクを **Baseline**（relationship/traverse/gapを使わないQueryのみ）と
  **Graphあり**で実行。測定は既存基盤を流用: Token Ledger（消費・Context量）、
  verdict台帳（評価品質）、failure台帳（見逃し・再発）、query_log（Context size）
- 判定基準はCONCEPTv2 §10の核心に合わせる: 「Graphなしでは見つけられなかった重要な判断・
  制約・依存関係を、Graphありで**事前に**発見できたか」（事後の人間指摘との突合 = Success 6）
- 対象はKPI Dashboard（§11）。**要決定: 題材とする会社データ**（実データ / 合成データセットを
  こちらで用意 / ユーザー指定）— 実験設計時にユーザーに確認する
- 評価軸は§12の10軸をevaluator群（llm_judge中心＋一部deterministic）として実装する

## 6. リスク

1. snapshot陳腐化の沈黙バグ → schema_version検査を実装の前提条件とする
2. predicate語彙ドリフト → gap/traverseは登録済みpredicateのみ辿る規約＋lint警告
3. LLMがs/p/oを使わずbody散文に書き続ける退行 → 分解Skillの出力契約＋relationship件数を検査する
   golden_taskで検出
4. conditions/exceptionsは当面自由文字列で機械検証不能 → AVAILABLE判定に寄与させない。
   条件の機械評価が必要になった時点でcondition型ノード＋applies_when辺へ昇格
5. asset refの宙吊り（改名・削除）→ gapがMISSINGとして検出、checkにref整合lintを追加
6. 辺1万本規模でのsnapshot再生成コスト → §16どおり顕在化時にのみ永続化層を検討

## 7. CONCEPTv2成功条件との対応

| 成功条件 | 本設計での実現 |
|---|---|
| S1: GoalからRequired Intelligence導出 | decompose-goal skill＋compile接地 |
| S2: 保有/不足の区別 | gapコマンドの6分類決定表 |
| S3: Relationによる新しい判断 | A/B実験（手順7）で検証 — 実装の成否でなく実験結果で判定 |
| S4: 知識不足と知性構造不足の区別 | classification拡張＋参照先ID |
| S5: Context削減とDecision Quality | traverse+reasoning_context Queryをquery_log/ledgerで測定 |
| S6: 人間指摘の事前発見 | KPI Dashboard実験の判定基準に組み込み |
