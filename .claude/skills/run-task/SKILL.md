---
name: run-task
description: 生成されたOS上でタスクを実行する。Objective→Plan→Execute→Evaluate→Next Actionのループを、Query経由の文脈取得とOSによる完了認定で回す。
---
<!-- autopoiesys:generated source=skills/run-task/SKILL.md — skills sync の生成物。編集は正本側に行う -->

# run-task

Task → Code → Done ではなく、Objective → Plan → Execute → Evaluate → Next Action → …
のループで仕事をする（設計原則§11）。**自分で「完了」を宣言してはならない。**

## 儀式はタスク規模に合わせる

台帳登録（手順1）と独立評価〜next-action（手順5-6）は完了認定の核であり、規模によらず外せない。
それ以外の固定費はタスク規模に応じてスケールさせる。迷ったら大タスク側に倒す:

- **小タスク**（目安: 変更1〜2ファイル・調査不要・可逆・不慣れな領域に触れない）:
  - Queryは手順2①（作法）と②の制約系1本まで。③横断契約と失敗パターン系は省略してよい。
    **①は小タスクでも省略できない** — 規約違反は変更の大きさに比例しないため
  - noteはフェーズ境界ごとでなく、実装完了時の1回でよい
  - 完了報告は5行以内（検証コマンドと結果・要件との対応のみ）
  - evaluatorはtask new時点で関連する最小構成にする（登録後に緩めるのは禁止のまま）
- **大タスク**（調査を含む・複数ファイル・不可逆操作や慣れない領域に触れる）: 手順どおり全て行う

## 手順

1. タスクを登録する。適用するEvaluatorをこの時点で決める
   （goal.yamlの関連するsuccess_criteria / constraintsのevaluatorを含めること）。
   作業対象ディレクトリ（worktree等）と参照（Issue/PR URL）も登録する —
   **継続性の正本は会話ではなくタスク台帳**であり、別プロセスがresumeしても
   `task show` だけで再開できる状態を保つ:

       node cli/index.js task new "<objective>" --evaluators <e1>,<e2> \
         --repos <scope>[=<dir>],... --refs <issue-url>

   **横断が常態なので、触るリポジトリはすべて `--repos` に登録する**（1つでも登録する）。
   scope名は goal.yaml sources に登録されているもの（`node cli/index.js query` の前に
   goal.yaml を確認するか、存在しないscopeを渡してエラーメッセージの一覧を見る）。
   worktreeで作業する場合は `<scope>=<worktreeのパス>` と明示する（省略時はsourcesのrepo）。

   evaluatorは `scope:` を宣言していれば、そのリポジトリのディレクトリで実行される。
   実行先が決まらないevaluatorを含めるとtask newが**登録時に失敗する** —
   誤ったディレクトリで検証してPASSを出す事故を防ぐための意図的な失敗なので、
   evaluatorを外すのではなく `--repos` に対象を足して解決すること。
   scopeを持たないevaluator（report_integrity等）は `--work-dir` → cwd で走る。

2. **文脈はQuery経由でのみ取得する**（T0）。World Model全体・events.jsonlの生読みは禁止。
   Query名はOSごとに異なるため、まず実在するQueryを列挙する（`node cli/index.js query`）。

   取得は**3本立て**で、役割が違うので1本で済ませない:

   | # | 何を | いつ | 絞り方 |
   |---|---|---|---|
   | ① 作法 | 対象リポジトリでの禁止事項・運用ルール・検証手段 | **触るリポジトリごとに必ず1回** | `scope` |
   | ② ドメイン | 製品仕様・ビジネス構造・過去の失敗パターン | タスクの話題に応じて | `tag` |
   | ③ 横断契約 | リポジトリ間の契約・二重実装・リリース順序 | **2つ以上に触るなら組み合わせごとに** | `scope`×2 |

       # ① 作法（scopeで引く。話題タグでは構造的に取り落とされる）
       node cli/index.js query get_repo_playbook --param scope=<repo>
       # ② ドメイン知識と既知の失敗パターン（scopeに依らない横断共通知識）
       node cli/index.js query <制約系Query> --param tag=<領域タグ>
       node cli/index.js query <失敗パターン系Query> --param tag=<領域タグ>
       # ③ 横断契約（触る組み合わせごと）
       node cli/index.js query get_cross_repo_contract --param repo_a=<A> --param repo_b=<B>

   規律:
   - **①を省略してはならない。** 作法系の知識は話題タグを持たないため、`tag` 絞りだけでは
     構造的に落ちる。実際にこれでリポジトリ固有の禁止事項を取り落とし、独立評価のFAILまで
     規約違反が検出されなかった実例がある
   - ①が `truncated: true` で返ったら `next_offset` で続きを取る。規約を読み残して実装に入らない
   - ②は `tag` で絞る（カンマ区切りはOR）。ここでリポジトリ名を渡す必要はない
   - ③が0件なのは「まだ記録されていない」意味であって「契約が無い」意味ではない。
     実装中に契約を見つけたら手順4で還流する

3. 計画・実行（T1-T2）。**成果物は初見の読者がコンテキストなしで読解できるかを推敲してから**
   登録する: 制作過程の記述（「初版は〜と判断したが」等）・セッション文脈への依存・内部タスクIDを
   本文に混入させない。経緯は文末の「変更履歴」セクションに隔離する（F003由来）:

       node cli/index.js task artifact <id> --path <p> --note "<説明>"

   フェーズ境界（調査完了・実装完了・検証完了）や重大な発見のたびに
   チェックポイントを台帳へ残す（コンパクション・プロセス交代への備え）:

       node cli/index.js task note <id> "<検証済みの事実・現在のステップ・次アクション>"

4. **学習をその場で還流する**（タスク終了・失敗を待たない）。
   実行中に次のいずれかに出会ったら、発見した時点でWorld Modelへ書き戻す:

   - コード・データで裏取りした、まだWMに無い事実
   - WMの既存Statementと実装の矛盾（仕様書由来の記述が実装と食い違う等）
   - ユーザーから受けた運用ルール・禁止事項

       node cli/index.js statement add "<事実>" --type constraint --tags <t> \
         --scope <repo> --source <裏取り元> --task <id>
       node cli/index.js statement supersede <S00xx> "<訂正後>" --source <裏取り元> --task <id>

   `--scope` の付け方が知識の到達性を決める:
   - 特定リポジトリの実装事実・作法 → `--scope <repo>`
   - **リポジトリ間の契約**（proto互換・同じ判定の二重実装・リリース順序） →
     `--scope <A>,<B>`。これを書き残すことが横断タスクの最大の資産になる
   - 製品仕様・ビジネス構造など実装先に依らない知識 → `--scope` を付けない
     （付けるとscope絞りのQueryに閉じ込められ、他リポジトリのタスクから見えなくなる）

   裏取りできていないものは status=hypothesis（--confidence必須）で書くか、書かない。

5. **完了報告のドラフトを書いてartifact登録してから**、独立評価を要求する。
   完了報告（実行した検証コマンドと結果・要件との対応・未実施事項）を評価対象とする
   evaluatorは、報告がOSに存在しないと判定不能（UNCERTAIN）になりループが止まる:

       # 例: .os/tasks/<id>-report.md に報告を書き、
       node cli/index.js task artifact <id> --path .os/tasks/<id>-report.md --note "完了報告"
       node cli/index.js evaluate --task <id>

   - deterministic / command は即時にverdictが記録される
   - llm_judge のbriefingが出力されたら、**新規サブエージェント**（この会話の履歴を
     持たないこと）にbriefingファイルだけを渡して判定・記録させる

6. 次の行動はOSに聞く:

       node cli/index.js next-action <id>

   DONEに `caveats` が付いていたら、**完了報告にそのまま転記する**。caveatsは
   「タスクのevaluatorは全てPASSしたが、この目的は現在測定できていない」という宣言であり、
   握りつぶすと「形式検査を全通過して目的未達」を完成として渡すことになる。

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

       node cli/index.js ledger add --purpose run-task --tier T2 --task <id>

   **トークン数は任意。実測値を持っていないなら入れない**（見積りを台帳に残すと
   コスト判断を誤る）。入れる場合は既定で見積り扱い（`estimated: true`）になり、
   API実測値のときだけ `--tokens-in <n> --tokens-out <n> --measured` を付ける。

## 運用ヒントの中継

CLI出力に「ヒント:」「警告:」で始まる行（regression推奨・Failure滞留・**評価未実行**）が
含まれていたら、省略せずユーザーにそのまま伝える。マニュアルを読まないユーザーに運用を
届ける経路なので、握りつぶさないこと。

特に「評価が未実行」の警告は、手順5-6を飛ばして完了報告に入ろうとしていることの
機械的な検出である。この警告が出ている状態で完了報告を書いてはならない。

## 禁止事項

- 自分の判断でタスクをDONE扱いにすること（next-actionがDONEを返すまで完了ではない）
- 評価器を一度も実行しないまま完了報告を書くこと（「評価が未実行」警告が出ている状態での報告）
- next-actionのcaveatsを完了報告から省くこと
- Queryを経由しない文脈収集（.os/world_model/ の直接読み込み）
- events.jsonlの直接編集（還流は `statement add` / `statement supersede` 経由のみ）
- 評価Evaluatorの選定を評価の直前に緩めること
