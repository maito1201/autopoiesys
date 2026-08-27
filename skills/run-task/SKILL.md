---
name: run-task
description: 生成されたOS上でタスクを実行する。Objective→Plan→Execute→Evaluate→Next Actionのループを、Query経由の文脈取得とOSによる完了認定で回す。
---

# run-task

Task → Code → Done ではなく、Objective → Plan → Execute → Evaluate → Next Action → …
のループで仕事をする（設計原則§11）。**自分で「完了」を宣言してはならない。**

## 手順

1. タスクを登録する。適用するEvaluatorをこの時点で決める
   （goal.yamlの関連するsuccess_criteria / constraintsのevaluatorを含めること）:

       node cli/index.js task new "<objective>" --evaluators <e1>,<e2>

2. **文脈はQuery経由でのみ取得する**（T0）。World Model全体・events.jsonlの生読みは禁止。
   Query名はOSごとに異なるため、まず実在するQueryを列挙してから選ぶ:

       node cli/index.js query            # 引数なしで一覧
       node cli/index.js query <制約系Query>
       node cli/index.js query <失敗パターン系Query>

   制約と過去の失敗パターンを**実行前に**必ず読む。Queryがパラメータ
   （where_param）を持つなら、タスクに関連するタグを渡して絞る
   （例: `--param tag=<対象リポジトリ名>`）。全件読みはトークンの無駄で、
   goal.yamlのtoken_efficiencyに反する。

3. 計画・実行（T1-T2）。作った成果物を登録する:

       node cli/index.js task artifact <id> --path <p> --note "<説明>"

4. **学習をその場で還流する**（タスク終了・失敗を待たない）。
   実行中に次のいずれかに出会ったら、発見した時点でWorld Modelへ書き戻す:

   - コード・データで裏取りした、まだWMに無い事実
   - WMの既存Statementと実装の矛盾（仕様書由来の記述が実装と食い違う等）
   - ユーザーから受けた運用ルール・禁止事項

       node cli/index.js statement add "<事実>" --type constraint --tags <t> --source <裏取り元> --task <id>
       node cli/index.js statement supersede <S00xx> "<訂正後>" --source <裏取り元> --task <id>

   裏取りできていないものは status=hypothesis（--confidence必須）で書くか、書かない。

5. 独立評価を要求する:

       node cli/index.js evaluate --task <id>

   - deterministic / command は即時にverdictが記録される
   - llm_judge のbriefingが出力されたら、**新規サブエージェント**（この会話の履歴を
     持たないこと）にbriefingファイルだけを渡して判定・記録させる

6. 次の行動はOSに聞く:

       node cli/index.js next-action <id>

   | 結果 | 行動 |
   |---|---|
   | DONE | 完了。ユーザーに報告 |
   | FIX | 修正して手順3-6を繰り返す |
   | INVESTIGATE | 原因を調査して再評価 |
   | COLLECT_EVIDENCE | 不足している証拠を集める（Query追加が必要なら提案） |
   | DEEP_RESEARCH | T3にエスカレーション（briefing編纂の上、research open） |
   | RESOLVE_CONFLICT | 矛盾する証拠を突き合わせて解消する |

7. ループ中に「必要なQueryが無い」「必要なEvaluatorが無い」と気づいたら、
   その場しのぎをせず `.os/proposals/` に提案を書く（OSの穴はOSの資産にする）。

8. Token Ledgerに記録する:

       node cli/index.js ledger add --purpose run-task --tier T2 --tokens-in <n> --tokens-out <n> --task <id>

## 運用ヒントの中継

CLI出力に「ヒント:」「警告:」で始まる行（regression推奨・Failure滞留）が含まれていたら、
省略せずユーザーにそのまま伝える。マニュアルを読まないユーザーに運用を届ける経路なので、
握りつぶさないこと。

## 禁止事項

- 自分の判断でタスクをDONE扱いにすること（next-actionがDONEを返すまで完了ではない）
- Queryを経由しない文脈収集（.os/world_model/ の直接読み込み）
- events.jsonlの直接編集（還流は `statement add` / `statement supersede` 経由のみ）
- 評価Evaluatorの選定を評価の直前に緩めること
