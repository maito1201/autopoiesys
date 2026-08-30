# PLAN: F008 — golden taskの検出力テストが検出器そのものを検証していない

事前固定。着手前に判定基準と手順を固定し、`task plan` でハッシュを台帳に残す。

## 何がこの仕事を要求したか

Failure **F008**（severity: high、agenda 1位 score 1.00）。
`node cli/index.js task new --origin failure:F008` として登録し、由来を台帳に解決させた。

## 症状（着手前の実測）

`scripts/check-self-directed.js` を全面的に書き換えた直後に `regression` を実行すると、
gt-009 は 9/9 PASS のままだった。verdict の evidence に出た出力文言は**旧版のもの**だった。

原因: `core/regression.js` の `runGoldenCheck` は fixture 付き check を `cwd = fixture` で
実行する。evaluator の `argv` は `[node, scripts/check-X.js, .os]` のような**相対パス**なので、
`scripts/check-X.js` は fixture の中に解決される。したがって fixture は検出器の複製を
持たなければ動かず、その複製は fixture 作成時点で凍結される。

範囲: command 方式の検出器6本すべて（docs_drift / experience_reuse / intelligence_trend /
policy_falsifiable / self_directed / skill_commands_portable）。fixture 内の複製は11個。

## 直すもの / 直さないもの（ここを混ぜない）

fixture の中のファイルには**2種類**あり、片方は正当である:

- **検出器が読むデータ**（`docs-drift-bad/core/store.js`、`SCHEMA.md` 等）:
  これは検査対象の入力であり、fixture にあるのが正しい。消してはならない
- **検出器そのもの**（`scripts/check-*.js`）: これが実装を影で置き換えている。消す

したがって不変条件は「fixture にファイルを置くな」ではなく、
**「evaluator が実行するスクリプトが fixture の中に存在してはならない」**である。

## 変更

1. `core/regression.js` `runGoldenCheck`: fixture 付きの command 実行で、`argv` の
   スクリプトパス（`node` の次の引数）が repoRoot からの相対パスとして実在するなら、
   **repoRoot 側の絶対パスに解決してから実行する**。cwd は fixture のままにする
   （`.os` や `.` といったデータ引数は fixture を指し続ける必要があるため）。
   解決した絶対パスを evidence に出す（どちらを実行したかが verdict の記録に残る）。
2. fixture 内の `scripts/check-*.js` 11個を削除する。
3. fixture のデータを現在の契約に合わせて更新する（例: `origin-self-pass` のタスクは
   `origin_verified` を持たないため、本体の検出器では PASS しない）。
   **この更新が必要になること自体が、これまで本体を検証していなかった証拠である。**
4. 新しい検出器 `scripts/check-fixture-shadowing.js`: golden_tasks と evaluators を読み、
   fixture 付き command check ごとに「実行されるスクリプトが fixture 内に存在しないか」を
   検査する。存在したら NG。**内容は強制せず、影の存在だけを見る**（S0018）。
5. golden task `gt-010`（検出力 fixture 両方向つき）と evaluator を追加し、regression に載せる。
6. Failure 台帳を reported → investigated → classified → upgrade_proposed → implemented と
   進める。

## 合格条件（結果を見る前に固定する）

- `npm test` 全件 PASS（現状 234 件 + 新規分）
- `node cli/index.js regression` が pass、golden 全件 PASS、failure_lint 0、check_errors 0
- **検出力の実測（両方向）**:
  - 新検出器: 影のある fixture で NG / 無い fixture で ok
  - gt-009 が**本体の** `check-self-directed.js` を実行していることを、verdict の evidence に
    出る絶対パスで確認する
- **反証（この修正が見かけだけなら何が観測されるか。着手後に必ず見る）**:
  本体の検出器をわざと壊し（一時的に）、`regression` が **FAIL に転じる**ことを実測する。
  転じなければ、まだ複製か別の経路を実行している。確認後ただちに戻す
- 既存の6本の検出器がすべて本体側を実行するようになったことを、evidence の絶対パスで確認する

## 前提の棚卸し（着手前）

| 前提 | 出所 | 対処 |
|---|---|---|
| fixture 内のデータ複製（SCHEMA.md・core/store.js 等）は正当であり消さない | 自分で決めた | 検出器が読む入力だからである。誤りなら、docs_drift の検出力テストが成立しなくなるので即座に分かる |
| スクリプトパスは `argv` の `node` の次の引数である | 自分で決めた | 現在の6本すべてがこの形。形が違う evaluator が現れたら解決しない（元の挙動のまま）ようにフォールバックする |
| fixture のデータ更新は「検証対象に合わせた修正」であって「テストを通すための細工」ではない | 自分で決めた | 更新の理由を報告に1件ずつ書く。書けないものは細工である |
| gitコミットはユーザーが行う | ユーザー指定 | 従う |
