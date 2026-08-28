---
name: investigate-failure
description: ユーザーの不満・FAIL verdictからFailureを調査する。Root Causeと「なぜOSはこれを防げなかったか」を特定し、OS Upgrade提案（新detector+新golden task）まで作る。T3許可。
---
<!-- autopoiesys:generated source=skills/investigate-failure/SKILL.md — skills sync の生成物。編集は正本側に行う -->

# investigate-failure

OSの最大の資産は失敗である（設計原則§12）。このSkillはFailureを**ログで終わらせず**、
Root Cause → 検出・予防戦略 → OS Upgrade提案 に変換する。T3の使用が許可される。

## 起動条件

- ユーザーの不満（「この結果は駄目だった」だけでも十分）
- evaluate の FAIL / 繰り返される UNCERTAIN
- next-action の DEEP_RESEARCH

## 手順

1. 起票（まだなら）:

       node cli/index.js feedback "<症状>" --task <id> --severity <low|medium|high>

   **既知fingerprint一致が表示されたら**、まず既存Preventionの適用を検討する（cheap経路）。
   一致しない場合のみ以降の本調査に進む。

2. 期待と実際の再構成。ユーザーの不満から expected outcome を復元し、actual と比較する。
   材料はQueryとタスク台帳・verdict台帳から集める:

       node cli/index.js task show <id>
       node cli/index.js query get_constraints

3. T3を使う場合は `.os/briefings/failure-<id>.md` に厳選文脈を編纂してから投入する。

4. Root Cause分析。**局所修正で止まらない**。必ず次の問いに答える:
   - Root cause は何か
   - **なぜOSはこれを検出できなかったのか**（why_undetected）
   - 何が欠けていたのか: Knowledge? Query? Constraint? Test? Evaluator? Workflow? Model?

       node cli/index.js failure transition <F> --to investigated --file <fields.json>
       node cli/index.js failure transition <F> --to classified --file <fields.json>

   `missing_evaluator` と分類すると、コアが `.os/proposals/<F>-evaluator.yaml` に
   検出器の提案スタブを自動起票する（遷移出力の `proposal_stub`）。
   **分類しただけで終わらせず、このスタブの `applies_to` / `method` / `checks` を埋めて
   手順5の提案に含めること。** 埋めなければ「分類はしたが検出器は生まれていない」ままになる。

5. OS Upgrade提案を作る。**最低限、次の2点を必ず含める**（コアが強制する）:
   - 新しいgolden task（このFailureの再発を検出する回帰テスト。可能なら既知の悪い状態を
     fixtureとして残し、検出器が実際にFAILを出せることを検証する = 検出力テスト）
   - 新しい検出系資産（evaluator / rule / query / detector）— 可能な限りT0の安価な検出器へ
     コンパイルする（設計原則§13: rgパターン・テスト・lint等）

   それに加えて、系統的な変更（Skill改訂・Workflow変更・goal.yaml改訂）が必要なら提案に含める。

       node cli/index.js failure transition <F> --to upgrade_proposed --file <fields.json>

6. **ユーザー承認を得てから** upgrade-os Skillで適用する。承認前に資産を本適用しない。

7. Token Ledger:

       node cli/index.js ledger add --purpose investigate-failure --tier T3

   トークン数は任意。実測値を持っていない見積りは入れない（入れる場合は既定で
   `estimated: true`、API実測値のときだけ `--tokens-in <n> --tokens-out <n> --measured`）。

## 禁止事項

- Failureをreportedのまま放置する（failure lintがregressionを不合格にする）
- 「このバグを直す」だけで終わる（why_undetectedに答えない提案は不完全）
- 分類だけして提案スタブを空のまま放置する（分類は検出器の代わりにならない）
- ユーザー承認なしのOS変更適用
