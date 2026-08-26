---
name: init-os
description: ユーザーの目的と運用体制をヒアリングしてGoal Specificationを作り、ユーザー固有OS（.os/）とスキルスタブを初期化する。OSはまだ作らない — まず達成したい状態と使われ方を理解する。
---

# init-os

あなたはOS Builderの入口である。**このSkillはOSを作らない。**
まずユーザーが本当に達成したい状態と、このOSが日々どう使われるか（運用）を理解し、
goal.yaml として固定する。

## 手順

### 1. 状況判定と環境診断

まず、いま居るワークスペースがどちらかを判定する:

- **OSS本体そのもの**（autopoiesysリポジトリ内） → CLIは `node cli/index.js`
- **別ドメインのワークスペース** → OSS Coreの場所を探す
  （同梱の `autopoiesys/` ディレクトリ、submodule、または隣接クローン）。
  CLIは `node <OSS Coreへのパス>/cli/index.js`。見つからなければユーザーに場所を聞くか、
  クローンを提案する

以後、このSkill内の `node cli/index.js` は判定したパスに読み替える。

    node cli/index.js doctor

NGがあれば内容を伝えて対処を促す（nodeが無い環境ではこのOSSは動かない）。

### 2. 雛形とスキルスタブの生成

    node cli/index.js init

これは `.os/` の雛形に加えて、**このワークスペース用のスキルスタブ（.claude/skills/）を
自動生成する**（OSS Coreへの参照パスは自動計算される）。出力の skill_stubs を確認し、
「新しいスキルはClaude Codeの次回セッション起動から /コマンドとして使える」ことを
ユーザーに伝える。

### 3. ヒアリング（目的）

以下を理解するまで質問する。ただし:

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

### 4. ヒアリング（運用）

OSは作って終わりではなく、使われて育つ。次の3点を短く確認する
（目的ヒアリングと同じ回で聞いてよい。デフォルトで済むなら聞かない）:

1. **利用リズム** — どのくらいの頻度で使うか（毎日/週次/不定期）。
   これに合わせて `.os/config.yaml` の `stale_after_days`（Failure放置の許容日数）を
   調整する（毎日使うなら7、週次なら14が目安）
2. **フィードバック経路** — 結果への駄目出しをどう受けるか。
   「不満は分析不要で一言でよい。/run-feedback が聞き取って起票する」ことを説明する
3. **`.os/` の履歴管理** — OSの成長履歴をgitで残すことを推奨し、承諾されたら実行する:

       git -C .os init

### 5. Goal Specificationの固定

ヒアリング結果を `.os/goal.yaml` に書き下ろす（形式はSCHEMA.md）。

- success_criteria / constraints の各項目に evaluator フィールドを付ける。
  まだ評価器が無いものは `evaluator: unbound` と明示する（隠さない）
- 運用ヒアリングの内容（利用リズム・フィードバック経路）も notes に残す
- ユーザーの発言原文は notes に保持する

検証し、unbound基準の一覧をユーザーに見せて承認を得る:

    node cli/index.js validate

### 6. 運用の引き継ぎ

承認後、次を短く伝えて締める:

- オーナーの役割は3つだけ: **タスクを言う**（/run-task）・**不満を言う**（/run-feedback）・
  **OS Upgrade提案を承認する**
- 成長は `node cli/index.js metrics` の数字で見える
- 詳細はOSS Coreの docs/USAGE.md にある

そのうえで discover-domain Skillへ進むことを提案する。

## 禁止事項

- goal.yamlにドメイン知識を書き溜めない（知識はWorld Modelへ、これはGoal定義のみ）
- ユーザーの承認なしにdiscover-domain以降を開始しない
- 運用ヒアリングを尋問にしない（デフォルトで済む項目は聞かずに進める）

## Token Ledger

このSkillでの自分のLLM作業を記録する（概算でよい）:

    node cli/index.js ledger add --purpose init-os --tier T2 --tokens-in <n> --tokens-out <n>
