---
name: build-evaluation-model
description: 目的に応じた独立評価システムを構築する。goal.yamlのunbound基準をEvaluatorに接地させ、Agentの「完了しました」を信用しないコードパスを作る。
---
<!-- autopoiesys:generated source=skills/build-evaluation-model/SKILL.md — skills sync の生成物。編集は正本側に行う -->

# build-evaluation-model

最重要コンポーネントの一つ（設計原則§9-10）。Agentは仕事を実行するが、**完了を認定するのはOS**。
このSkillは `.os/evaluators/<id>.yaml` を設計・生成し、goal.yaml の evaluator 接地を進める。

## 手順

1. 未接地の基準を確認する:

       node cli/index.js validate

   unbound一覧が、作るべきEvaluatorのバックログである。

2. 各基準に対し、**最も安い方法で判定できる形**を選ぶ（tierを下げる圧力を常にかける）:
   - T0 `deterministic`: ファイル・正規表現・Query結果のアサーション
   - T0 `command`: 既存のテスト・lint等（argv配列で宣言。シェル文字列禁止）
   - T1-T2 `llm_judge`: 決定的に書けない判断のみ。rubricとcontext_queriesを宣言

3. `.os/evaluators/<id>.yaml` を書く（形式はSCHEMA.md）。設計規律:
   - 判定不能な状況を隠さない — 3値（PASS/FAIL/UNCERTAIN）で設計する
   - llm_judgeのrubricには「UNCERTAINと言ってよい条件」を必ず書く（偽PASSより
     UNCERTAINが望ましい）
   - hard制約のEvaluatorは可能な限りT0にする（違反検出を決定的にする）
   - **`kind` を必ず宣言する**: `conformance`（規定への適合: 枠・語彙・引用・プロセス）か
     `outcome`（目的の達成: 成果物の外側の効果）。
     **各success_criteriaには最低1つ outcome を束縛する** — conformanceだけで固めると、
     形式検査を全通過しながら目的未達の成果物が完成扱いになる。
     outcomeは「初見の読者が指定の発見に到達できるか」のように成果物の外を測るもので、
     決定的に書けないなら golden_tasks に人間判定1回を型として残す形でよい。
     `check` は outcome で裏付けられていない success_criteria を警告する

4. goal.yaml の `evaluator: unbound` を実IDに置き換え、検証する:

       node cli/index.js validate
       node cli/index.js check

5. `.os/proposals/evaluator-*.md` があれば消化する。

## 独立性の規約（このSkillが生成する評価の実行方法）

- 評価の実行は `node cli/index.js evaluate --task <id>` のみ
- llm_judgeの判定は**生成エージェントとは別の新規サブエージェント**が、
  生成されたbriefing（`.os/briefings/eval-*.md`）だけを読んで行う
- 決定的評価のFAILはLLM判定で覆せない（コアが強制）

## Token Ledger

    node cli/index.js ledger add --purpose build-evaluation-model --tier T2

トークン数は任意。見積りを台帳に入れない（実測値があるときだけ
`--tokens-in <n> --tokens-out <n> --measured`）。
