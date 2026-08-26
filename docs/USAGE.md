# autopoiesys オーナーズマニュアル — 使いながら育てる

このリポジトリには2つのものが同居している。

1. **OSS Core**（コミット済みのコード）— どのドメインのOSも作れる汎用エンジン
2. **あなたのEngineer OS**（`.os/`、gitignore済み）— autopoiesys開発という仕事のために
  既に構築された、あなた固有の知性の蓄積

このガイドは後者を「使いながら育てる」ための手引き。

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

## 4. 育っているかを数字で見る

```bash
node cli/index.js metrics --json
```

見るべき指標:

| 指標 | 意味 | 育っていれば |
|---|---|---|
| tokens.cheap_path_coverage | 高価なLLM(T2/T3)なしで完了したタスク比率 | 上がる |
| tokens.by_task | タスクあたりトークン | 同種タスクで下がる |
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

## 6. 中身を理解したくなったら、この順に読む

すべてプレーンテキストで、git diffで変化を追える。

1. `.os/goal.yaml` — このOSに何を約束させているか（成功基準と禁止事項）
2. `.os/evaluators/` — 「完了」の定義そのもの。1ファイル=1判定器
3. `.os/failures/ledger.jsonl` — OSが何を失敗から学んだか（why_undetectedが読みどころ）
4. `.os/queries/` — エージェントが世界をどう見ているか（文脈の取得窓口）
5. `.os/world_model/events.jsonl` — 蓄積された知識。fact/hypothesis/unknownが区別されている

形式の辞書は [SCHEMA.md](../SCHEMA.md)、設計判断の理由は [DESIGN.md](DESIGN.md)。

## 7. `.os/` の履歴管理（推奨）

`.os/` はOSS本体からgitignoreされている（CONCEPT §22の分離）。あなたのOSの成長履歴を
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
  作ると、コアがEngineer専用に歪んでいないかが検証できる。これがCONCEPTの汎用性の証明
