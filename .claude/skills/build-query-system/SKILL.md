---
name: build-query-system
description: 対象領域に応じたQuery interfaceを設計・生成する。World Model全体をLLMに渡さないための唯一のアクセス面を作る。
---
<!-- autopoiesys:generated source=skills/build-query-system/SKILL.md — skills sync の生成物。編集は正本側に行う -->

# build-query-system

QueryはOS Builderが領域に応じて設計するものであり、固定APIではない（設計原則§7）。
このSkillの仕事はコードを書くことではなく、`.os/queries/<name>.yaml` の宣言的定義を
設計・追加すること。実行は決定的Queryエンジンが行う。

## 手順

1. Query需要を特定する。出発点:
   - goal.yaml の success_criteria / constraints（評価に必要な情報は何か）
   - World Modelの内容: `node cli/index.js query` で既存Query一覧、
     `node cli/index.js check` でStatement数を確認
   - `.os/proposals/query-*.md`（discover-domainやinvestigate-failureからの提案）
   - 実際のタスク実行で「情報が足りなかった」場面

2. 各Queryを `.os/queries/<name>.yaml` に定義する（形式・pipeline語彙はSCHEMA.md）。
   設計規律:
   - **max_tokensを必ず宣言する**（無制限Queryは作れない — §26⑤）
   - 1 Query = 1 目的。descriptionに「いつ使うQueryか」を書く
   - **絞り込み軸を設計する**: where_paramのタグ絞りが実際に効くのは、タグ語彙に
     リポジトリ名だけでなく領域軸（ドメイン・作業種別: billing / migration / test 等）が
     あるとき。Statement蓄積時のタグ付けと合わせて設計する。paramのカンマ区切りは
     OR条件として解釈される（`--param tag=billing,test`）
   - 可能なら golden（期待件数など）を添えてQuery自体を回帰対象にする
   - **作法系（禁止事項・運用ルール）は話題タグを持たない**。scopeで引ける経路を必ず1本置く
     （話題タグ絞りだけのQuery群にすると、規約が構造的に取り落とされる）

3. 動作確認。**Queryを足したら到達性を測る**（Query設計の良し悪しは「World Modelの全事実が
   どれかのQueryから返ってくるか」で決まる。引けない事実は運用上存在しない）:

       node cli/index.js query <name> --param k=v
       node cli/index.js audit reachability
       node cli/index.js check

   `unreachable` に残ったStatementは、絞り込み軸が足りない（孤児タグ）か、limit/max_tokensの
   枠から常に落ちている。**Queryを足すか枠を上げて0件にする**。
   `project` に `id` を含めること（idが無いQueryは引用の裏取りも到達性監査もできない）

4. 対応するproposalファイルがあれば削除する（提案の消化）。

## 同梱Query

`init` が `queries/get_past_decisions.yaml`（過去の決定と結果）だけを生成する。
decision / outcome はコアの語彙なので、引く手段までコアが用意する。
ユーザーが編集していれば `init --force` でも上書きしない。

ただし**判断の場で引くのはこのQueryではなく `decision recall` / `policy match` である**。
Queryは一覧の閲覧用で、再来の検出と方針の発火はコアが決定的に行う（推論もQueryも経ない）。

## 典型的なQuery（あくまで例 — 領域に合わせて設計する）

- get_constraints — 有効な制約（タスク実行前に必ず読む）
- get_historical_failures — 過去のFailureと予防資産
- get_open_unknowns — 未解決のUnknown（調査候補。`blocks` / `importance` を
  projectに含めると「どの判断を塞いでいるか」で並べられる）
- get_counter_evidence — ある仮説への反証
- get_related — あるStatementの関連（expandステップ）

## pipeline DSLで表現できない場合

まず出力の分割（params + offset）を検討する。それでも不足する需要は
OSS Coreへのステップ追加提案として `.os/proposals/` に書く。
（`.os/plugins/` の逃げ道機構はCore側が未実装。実装されるまで使わないこと）

## Token Ledger

    node cli/index.js ledger add --purpose build-query-system --tier T2

見積りは台帳に入れない（API実測値があるときだけ `--tokens-in <n> --tokens-out <n> --measured` を付ける）。
