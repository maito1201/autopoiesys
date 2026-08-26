---
name: upgrade-os
description: 承認済みのOS Upgrade提案を適用し、regression（golden task全件+検出力テスト+failure lint）で検証してOSバージョンを進める。悪化したらロールバックする。
---

# upgrade-os

OS Upgradeは資産のdiffとして適用し、必ずregressionで検証する（CONCEPT §16-17）。

## 前提

- investigate-failure による upgrade_proposed 状態のFailureがあり、**ユーザーが提案を承認済み**であること

## 手順

1. `.os/` がgit管理されている場合はブランチ（または適用前コミット）を作り、
   ロールバック地点を確保する。git管理されていなければ `.os/` のバックアップコピーを取る。

2. 提案の資産を適用する:
   - 新evaluator → `.os/evaluators/`
   - 新query → `.os/queries/`
   - 新rule → `.os/rules/`
   - 新golden task → `.os/golden_tasks/`（origin_failureを必ず書く。可能なら既知の悪い状態の
     fixtureを添えて検出力テストにする）
   - Skill改訂・OSS Core変更が必要なもの → `.os/proposals/` に提案として残す（無断編集しない）

3. 整合検査と回帰:

       node cli/index.js check
       node cli/index.js regression

4. 結果で分岐:
   - **PASS** → Failureを完了させ、OSバージョンを進める:

         node cli/index.js failure transition <F> --to implemented --file <assets.json>

     （assetsにgolden_taskと検出系資産、regression_refを記載 — コアが強制する）
     `.os/config.yaml` の os_version をインクリメントし、git管理なら
     `os-v<N>` タグ（またはコミット）を付ける。
   - **FAIL** → 適用を巻き戻し、regression結果を添えて調査に戻る。
     **巻き戻し自体もFailureとして起票する**（アップグレードの失敗はOSの失敗）。

5. 完了報告には次を含める: 適用した資産一覧 / regression結果（golden件数・検出力テスト結果）/
   新しいos_version / 残った提案（proposals）。

6. Token Ledger:

       node cli/index.js ledger add --purpose upgrade-os --tier T2 --tokens-in <n> --tokens-out <n>

## 禁止事項

- regressionを実行せずにimplementedへ遷移する（コアがregression_refを要求する）
- 悪化したregressionを「別問題」として放置する
- 提案に無い変更をこの機会に紛れ込ませる
