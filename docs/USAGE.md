# autopoiesys オーナーズマニュアル — 使いながら育てる

ワークスペースには2つのものが同居している。

1. **OSS Core**（コミット済みのコード）— どのドメインのOSも作れる汎用エンジン
2. **あなたのOS**（`.os/`、gitignore済み）— `/init-os` で宣言したあなたの目的のために
  構築される、あなた固有の知性の蓄積

このガイドは後者を「使いながら育てる」ための手引き。目的の領域は問わない
（本文の例はエンジニアリングを題材にしているが、KPI監視でもカスタマーサポートでも
読み替えは同じ）。

## 0. あなたの役割は3つだけ

設計や実装の理解は前提にしない。オーナーの仕事は:

1. **目的・タスクを言う** — 「〇〇を実装して」
2. **不満を言う** — 「この結果は駄目だった」の一言でよい。**これがOSの最重要の栄養**
3. **承認する** — OSが自分を作り替える提案（OS Upgrade）にYes/Noを出す

それ以外（調査・実装・評価・失敗分析・検出器の生成）はOSとエージェントの仕事。

## 1. 1分でわかる仕組み

```
あなた「タスクをやって」
   → エージェントが .os/queries/ 経由で文脈を取得（制約・過去の失敗を必ず読む）
   → 実装
   → OSが独立評価（.os/evaluators/）— エージェントの「できました」は使われない
   → PASSならDONE、FAILなら差し戻し。完了を決めるのはOS

あなた「駄目だった」
   → Failure台帳に起票 → 根本原因と「なぜOSは防げなかったか」を調査
   → 新しい検出器＋回帰テストが .os/ に増える ← これが「育つ」の実体
   → 次から同じ失敗はT0（LLMなし・トークンゼロ）で自動検出される
```

育つ＝`.os/` にプレーンテキストの資産（検出器・Query・回帰テスト・知識）が増え、
同じ失敗が二度と高いLLM推論を必要としなくなること。

## 2. 日常ループ: タスクを頼む

Claude Codeでこのリポジトリを開き、開発タスクは `/run-task` で依頼する:

```
/run-task READMEのクイックスタートに不足している手順を直して
```

エージェントではなくOSがDONEを宣言したら完了。途中でFIX/INVESTIGATEが出るのは正常動作
（OSが仕事を突き返している）。あなたは結果だけ見ればよい。

## 3. 駄目だったとき（ここでOSが育つ）

結果に不満があれば、理由を分析する必要はない。一言でよい。`/run-feedback` に伝えると、
エージェントが症状をヒアリングして起票する:

```
/run-feedback この結果は駄目だった。俺ならこうしていた: ...
```

CLIから直接起票してもよい:

```bash
node cli/index.js feedback "この結果は駄目だった。俺ならこうしていた: ..."
```

続けて `/investigate-failure` を実行させると、OSは
根本原因 →「なぜOSはこれを防げなかったか」→ アップグレード提案（新しい検出器＋回帰テスト）
まで進めて、**あなたの承認を待つ**。

承認時に見るのは2点だけ:
- **提案内容**（`node cli/index.js failure show F00N`）— 何が増えるのか
- **regression結果** — 既存の golden tasks が全部PASSしているか（壊していない証明）

承認したら `/upgrade-os` で適用され、os_versionが上がる。

## 3.5 判断を畳み込んで、考え直さずに済むようにする

同じ判断を毎回ゼロから、しかも前回の結果を知らないままやり直すのは高くつく。
決定は「何を選ぶ場面か（situation）」に紐づけて残す:

```bash
node cli/index.js decision new "5分足のまま研究を続ける" --situation "デイトレ研究の足の粒度を選ぶ" --options "5分足,日足" --chosen "5分足" --criteria "同一日内の出入りが測れるか" --expected "同一日内の出入りが測れる"
```

**同じ場にもう一度立つと、前回の選択と結果がその場で返ってきます。**
場の同一性は situation の文字列だけで決まります（選択肢は同定に使いません —
同じ場で比べる手が増減しても同じ場です）。situation の言い回しがずれて完全一致しない
ときは、語が重なる過去の決定が「近い場」として併せて返ります。

答え合わせを引きに来させる作りにはしていません。過去の決定は
`task new` / `task brief` の想起に混ざって黙って届き、決定を下したタスクが完了すると
「結果が未記録だ」が運用ヒントと `agenda` に出ます。答え合わせは:

```bash
node cli/index.js decision outcome S0012 --result met --note "同一日内の出入りが測れた"
```

同じ選択が2回以上反復し、結果が met で、unmet が1件も無くなると、
その判断は**方針**として `.os/rules/` に畳み込まれます。以後、同じ場では
LLM推論をまったく使わずに選択が返ります。

```bash
node cli/index.js policy match "デイトレ研究の足の粒度を選ぶ"
```

方針は反証されると自動で撤回されます（`unmet` が1件出た時点、または方針に反する選択が
`met` になった時点）。裁量で残すことはできません。育ち具合は `metrics` の
`policy.outcomes` で見ます — 方針の下で下した判断と、熟慮した判断の met/unmet を
並べた2列です。**発火数が多いことは良いことではありません。**

## 3.55 サブエージェントに文脈を渡す

仕事を別のエージェント（会話履歴を持たない別プロセス）に委ねるとき、会話を切り貼りして
渡すと、渡した側の思い込みごと渡すことになります。OSに選抜させます:

```bash
node cli/index.js context --task T012 --purpose "検出器の複製がないかを調べる" --max-tokens 800
```

出力は、そのタスクの語・類型・確立済みの方針・1ホップの反証だけを決定的に選んだ
最小のReasoning Contextです。LLMは通りません。判定者（llm_judge）が受け取っているものと
同じ装置で、渡す相手が実行側になっただけです。消費したトークンは
`observations/context_log.jsonl` に `kind: context` として記録されます。

## 3.6 日々の仕事を成長に変える

同じ種類の仕事には同じ類型（class）を付けます。これが日々の成長の入口です:

```bash
node cli/index.js task new "今日の銘柄スクリーニングを回す" --class "日次の銘柄スクリーニング" --evaluators e1,e2 --repos kabu
```

2回目以降は、**過去の同種タスクで学んだ教訓が、聞かなくても出力に届きます**。
タスクが終わったら、学んだことを1行に蒸留して締めます:

```bash
node cli/index.js statement add "寄り付き直後の板は薄いので判定から除外する" --type lesson --when "日次スクリーニングの朝一実行" --source "T012の実測" --task T012
```

```bash
node cli/index.js task consolidate T012 --lessons S0031 --helped S0020 --misled S0018
```

教訓は正しいのに適用しなかった（適用場面があったのに使い損ねた）場合は、
misled ではなく unapplied で開示します — misled と書くと正しい教訓が反証で引退します:

```bash
node cli/index.js task consolidate T012 --lessons S0031 --unapplied S0036 --unapplied-reason "適用場面はあったが再測定を怠った"
```

外れた教訓（--misled）は反証として記録され、外れが続いた教訓は届かなくなります。

ただし「効いた／外れた」は**作業した本人の申告**です。申告のままだと、教訓の実績数は
自己申告の合計にしかなりません。申告が台帳の記録と整合するかは、会話履歴を持たない
別の判定者に見てもらいます:

```bash
node cli/index.js experience audit T012
```

台帳の機械記録（成果物の登録時刻・評価のverdict・想起の配信ログ・事前固定した手順）と
申告そのものだけを載せたbriefingが `.os/briefings/` に出ます。完了報告の本文は入りません
（申告の説明を読んで申告を判定してしまわないためです）。判定はこう記録します:

```bash
node cli/index.js experience audit-record T012 --lesson S0020 --result supported --note "根拠にした記録"
```

`contradicted`（記録が申告と食い違う）を記録すると、蒸留が書いた「効いた」の裏づけは
撤回され、反証が監査者名義で書き戻されます。記録に現れないだけなら `insufficient` です
（台帳に無いことは、起きなかったことを意味しません）。

成長したかは類型ごとの系列で見ます:

```bash
node cli/index.js growth スクリーニング
```

試行ごとのFAIL数・トークン・教訓数が並びます。試行3回未満の類型では傾向は出ません
（出せないものを出さないのは仕様です）。

やることが分からなくなったら、OSに聞きます:

```bash
node cli/index.js agenda
```

未解決のUnknown・止まっているFailure・外れた教訓・測れていない基準から、
次にやるべき仕事が優先度つきで返ります。適用済みの提案は消え、既に着手している項目は
着手中のタスクIDつきで順位が下がります。

**一度も動いていない器官**（`dead_organ`）も同じ並びに出ます。方針が畳み込まれていない、
決定の結果が照合されていない、Ledgerが全件見積り — こうした「作ったが使われていない」層は、
テストが全通過していても実運用の記録が0件のままになります。出るのは事実だけで、
「使え」とも「消せ」とも言いません（負債の返し方は使うと捨てるの両方があります）。
仕事を1周する前のOSでは出ません。記録が読めないとき（台帳に壊れた行があるとき）は
0件と数えず、警告として出ます。

挙がった仕事に着手するときは、どの項目に由来するかを登録します:

```bash
node cli/index.js task new "..." --origin agenda:S0035 --class "..." --evaluators e1 --repos r
```

`--origin` がOS由来（`agenda:` / `failure:` / `lesson:` / `unknown:`）を名乗る場合、
指した項目が台帳に実在するかを登録時に照合します。実在しなければ**登録は失敗します** —
接頭辞つきの文字列を打つだけで「自発的に動いた」ことになってしまうからです。

## 4. 育っているかを数字で見る

```bash
node cli/index.js metrics --json
```

見るべき指標:

| 指標 | 意味 | 育っていれば |
|---|---|---|
| tokens.cheap_path_coverage | 高価なLLM(T2/T3)なしで完了したタスク比率 | 上がる |
| tokens.by_task | タスクあたりトークン（**自己申告**） | 同種タスクで下がる |
| context.briefing_tokens_total | 評価に渡した文脈の量（**コアの実測**） | 同種タスクで下がる |
| verdicts.deterministic_ratio | 決定的評価の比率 | 上がる |
| failures.open | 未消化の失敗 | 0に保つ |
| compile_candidates | 「これを資産化せよ」というOSからの提案 | 出たら対応 |

もう1つの重要な穴リスト:

```bash
node cli/index.js validate
```

`unbound` に出るのは「成功基準として約束したのに、まだ機械的に検証できていないもの」。
これが減っていく＝OSの完了認定が信用できるようになっていく。
現在は sc-003（ドキュメント整合）と c-003（シェル構文禁止）が未接地で残っている。

## 5. 定期メンテ（週1程度、エージェントに頼んでよい）

```bash
node cli/index.js regression
```

golden tasks全件＋検出力テスト＋failure lint＋整合検査。FAILしたら放置せず
`/investigate-failure`。7日以上放置された失敗はregression自体を不合格にする仕様
（失敗のログ死蔵を機械的に禁止している）。

知識の取りこぼしと死蔵も同じ頻度で見る。**「知識の拡充を思いつけるかどうか」を
オーナーのセンスに委ねないための2本**で、どちらも決定的（LLMゼロ）:

```bash
node cli/index.js sources scan          # 未登録の知識源（規約ファイル・自動メモリ）を発見する
node cli/index.js audit reachability    # 取り込んだ知識がQueryから引けるかを検査する
```

- `sources scan` の `undecided` は「登録も除外もされていない知識源」。goal.yamlの`sources`に
  足すか、`excluded_sources`に理由付きで書いて0件にする。`doc_clusters` はファイル名からは
  正本と判定できないドキュメント群の在処で、正本があれば`rule_docs`へ足す
- `audit reachability` の `unreachable` は「World Modelにあるのにどのクエリからも返らない事実」。
  実行時には存在しないのと同じなので、Queryの絞り込み軸を足すか、tag/scopeを直して0件にする

`check` はこの2つの結果を警告として毎回出すので、普段は気づくだけでよい。

覚えていなくてもよい: 普段のコマンド（タスク登録・成果物登録・評価・feedback・ledger等）の
ついでに、regressionが`regression_every_days`（既定7日）を超えて未実行のときや、Failureの
滞留が締め切りに近づいたとき、**評価器を一度も実行しないまま開いているタスクがあるとき**、
OSが「ヒント:」「警告:」として自分から知らせてくる。

Claude Code用のスキル（`.claude/skills/`）は `skills/` の生成コピーなので、Core更新後は
同期する。CIに `--check` を置けばズレが検出できる:

```bash
node cli/index.js skills sync            # 生成コピーを正本に合わせる
node cli/index.js skills sync --check    # ズレていれば非ゼロ終了（書き換えない）
```

## 6. 中身を理解したくなったら、この順に読む

すべてプレーンテキストで、git diffで変化を追える。

1. `.os/goal.yaml` — このOSに何を約束させているか（成功基準と禁止事項）
2. `.os/evaluators/` — 「完了」の定義そのもの。1ファイル=1判定器
3. `.os/failures/ledger.jsonl` — OSが何を失敗から学んだか（why_undetectedが読みどころ）
4. `.os/queries/` — エージェントが世界をどう見ているか（文脈の取得窓口）
5. `.os/world_model/events.jsonl` — 蓄積された知識。fact/hypothesis/unknownが区別されている

形式の辞書は [SCHEMA.md](../SCHEMA.md)、設計判断の理由は [DESIGN.md](DESIGN.md)。

## 7. `.os/` の履歴管理（推奨）

`.os/` はOSS本体からgitignoreされている（設計原則§22の分離）。あなたのOSの成長履歴を
残すため、`.os/` 自体を独立リポジトリにすることを推奨する:

```bash
git -C .os init
```

以後、OS Upgradeのたびに `.os/` 内でコミットすれば、「OS v1→v2で何が変わったか」が
すべてdiffで監査できる。

## 8. やってはいけないこと

- エージェントの「完了しました」を信じてタスクを閉じる（next-actionがDONEを返すまで未完了）
- `.os/` の台帳（*.jsonl）を手で編集する（検証を迂回すると評価の信用が壊れる。
  goal.yamlやevaluatorの**定義**を編集するのは問題ない — その後 `check` を通すこと）
- feedbackを言わずに我慢する（不満はOSにとって唯一無二の学習データ。遠慮は成長の機会損失）

## 9. OSS Core自体を育てる場合

生成されたOSがCore側の欠陥・不足を見つけると `.os/proposals/` に提案を書く（勝手に
Coreを編集しない規約）。たまに覗いて、良い提案は通常のOSS開発としてコミットする。
このとき「Coreの変更でOSが壊れていないか」は `node cli/index.js regression` が答える。

## 10. 次の成長関門

- **unbound基準の解消** — `/build-evaluation-model` でsc-003/c-003に評価器を接地させる
- **タスク数を積む** — cheap_path_coverageの改善はトイ実証しかない。数十タスクで真偽が出る
- **Phase 2: 第2ドメイン** — 非エンジニア領域（例: KPI監視）で `init` からOSをもう1つ
  作ると、コアがEngineer専用に歪んでいないかが検証できる。これが設計原則§23（同一エンジンでの汎用性）の証明

## 11. 別目的のOSを立ち上げる

`.os/` はワークスペースに1つで、目的専用に染まる。**別目的のOSは別リポジトリに作る**:

```bash
mkdir ../my-new-os
cd ../my-new-os
git init
git clone https://github.com/maito1201/autopoiesys autopoiesys
node autopoiesys/cli/index.js init
```

（1行ずつ実行。bash / PowerShell 共通で動く）

`init` が `.os/` に加えてスキルスタブ（`.claude/skills/`、OSS Coreへの参照パスは自動計算）
も生成する。あとはClaude Codeをその新リポジトリで開き直して `/init-os` — 目的と運用の
ヒアリングから、そのドメイン専用OSの構築が始まる。

いま居るワークスペースの `.os/` は、そこで最初に宣言した目的専用のまま使い続ける。
あとから別目的を混ぜない。
