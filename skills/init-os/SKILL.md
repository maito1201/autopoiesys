---
name: init-os
description: ユーザーの目的をヒアリングしてGoal Specificationを作り、ユーザー固有OS（.os/）を初期化する。OSはまだ作らない — まず達成したい状態を理解する。
---

# init-os

あなたはOS Builderの入口である。**このSkillはOSを作らない。**
まずユーザーが本当に達成したい状態を理解し、goal.yaml として固定する。

## 手順

1. 環境診断:

       node cli/index.js doctor

   NGがあれば内容を伝えて対処を促す（nodeが無い環境ではこのOSSは動かない）。

2. `.os/` の雛形を生成する（既にあればスキップ）:

       node cli/index.js init

3. **ヒアリング**。以下を理解するまで質問する。ただし:
   - 質問はテンプレートの機械的読み上げではなく、ユーザーの目的に応じて動的に生成する
   - 質問数を最小化する。**既に取得可能な情報（リポジトリの中身・既存ドキュメント等）は
     ユーザーに質問せず自分で調べる**
   - 一度に最大5問。足りなければ追質問する

   最低限理解すべきこと:
   - Goal: 最終的に何ができるようになりたいか
   - Current workflow: 現在、人間はどうやってその仕事をしているか
   - Success: 何が起きたら「このOSは成功した」と判断するか
   - Failure: 過去に何が失敗しているか
   - Constraints: 絶対にやってはいけないことは何か
   - Human intervention: どこまで自律してよいか
   - Available information: 何のデータ・ツール・システムにアクセスできるか

4. ヒアリング結果を `.os/goal.yaml` に書き下ろす（形式はSCHEMA.md）。
   - success_criteria / constraints の各項目に evaluator フィールドを付ける。
     まだ評価器が無いものは `evaluator: unbound` と明示する（隠さない）
   - ユーザーの発言原文は notes に保持する
5. 検証し、unbound基準の一覧をユーザーに見せて承認を得る:

       node cli/index.js validate

6. 承認後、discover-domain Skillへ進むことを提案する。

## 禁止事項

- goal.yamlにドメイン知識を書き溜めない（知識はWorld Modelへ、これはGoal定義のみ）
- ユーザーの承認なしにdiscover-domain以降を開始しない

## Token Ledger

このSkillでの自分のLLM作業を記録する（概算でよい）:

    node cli/index.js ledger add --purpose init-os --tier T2 --tokens-in <n> --tokens-out <n>
