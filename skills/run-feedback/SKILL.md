---
name: run-feedback
description: ユーザーの不満をヒアリングしてFailureとして起票する。原因分析はユーザーに求めず、症状の言語化と登録・振り分け（cheap経路 or investigate-failure）だけを行う。
---

# run-feedback

不満はOSにとって唯一無二の学習データである（CONCEPT §12）。このSkillは
ユーザーの「駄目だった」を**会話で消化して終わらせず**、必ずFailure台帳に載せる。
根本原因の調査はしない（それは investigate-failure の仕事）。

## 起動条件

- ユーザーが結果に不満を表明した（「駄目だった」の一言でも十分）
- run-taskの成果物にユーザーが駄目出しをした
- ユーザーが期待と違う挙動を報告した

## 手順

1. ヒアリング。**原因分析をユーザーに要求してはならない**。聞くのは最大で次の3点、
   1回の質問でまとめて聞く。答えが得られなくても登録は進める:

   - 期待していた結果は何か（expected）
   - どのタスクの話か（--task に使う。不明なら省略してよい）
   - どのくらい深刻か（--severity low|medium|high。不明なら medium）

   ユーザーの発言から実際に起きたこと（actual）を復元し、
   「expectedはXだったがactualはYだった」の形で症状を1〜3文に言語化する。
   ユーザーの言葉を弱める言い換え（「少し気になる点」等）をしない。

2. 起票する:

       node cli/index.js feedback "<症状>" --task <id> --severity <low|medium|high>

3. 出力のfingerprint判定で振り分ける:

   | 出力 | 行動 |
   |---|---|
   | 既知のFailureパターンに一致 | 既存Preventionの適用を検討する（cheap経路。T3を使わない） |
   | 未知のfingerprint | investigate-failure Skill（T3許可）での調査開始をユーザーに提案する |

   調査を勝手に開始しない。提案して、ユーザーの指示を待つ。

4. Token Ledgerに記録する:

       node cli/index.js ledger add --purpose run-feedback --tier T1 --tokens-in <n> --tokens-out <n>

## 禁止事項

- ユーザーに原因分析・再現手順の作成を要求する（一言の不満で起票できるのがこのSkillの価値）
- 不満を聞いて弁明・反論し、起票せずに会話を終える
- 症状をユーザーの発言より弱い表現に言い換える
- このSkill内でRoot Cause調査やOS Upgrade提案を始める（investigate-failureへ引き継ぐ）
