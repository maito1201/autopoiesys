---
name: build-evaluation-model
description: 目的に応じた独立評価システムを構築する。goal.yamlのunbound基準をEvaluatorに接地させ、Agentの「完了しました」を信用しないコードパスを作る。
---

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

## 検出器を作るときの2つの落とし穴

実運用で、検出器そのものが失敗した事例が2種類ある。どちらも設計段階で避けられる。

### ① 内容を強制する検出器を作らない — 開示だけを強制する

「前提を無検証で継承した」という失敗への予防として、
**特定の前提を守らせる検出器を作ってはいけない。** それは前提を機械に焼き付ける行為で、
同じ失敗の再現になる（過去のAIが決めた規則を、今度は検査で強制することになる）。

作るべきは**開示を強制する検査**である。例:

```yaml
# 良い例: 何が正しいかは決めず、出所が書かれているかだけを見る
id: premise_disclosure
tier: T0
kind: conformance
method: command
argv: [python, guards/check_premise_disclosure.py]
```

検査の中身は「成果物に前提の棚卸し表があり、各行の出所が
{ユーザー指定, 過去のAI, 測定, 自分で決めた} のいずれかで明示され、
**ユーザー指定以外の行に対処が書かれている**」ことだけ。どの前提が正しいかは判定しない。

固定制約はユーザーが明示した指定条件だけであり、過去の測定結果・棄却済みの判断・
蓄積された知見は、使う瞬間に確認する検証対象である。この非対称性を検出器に焼き込む。

### ② 検出力より先に「正しい状態で鳴らないこと」を確かめる

**誤検出する検出器は無視されるだけで、無いのと同じか、それ以下である。**
実際に破棄した例が2件ある。

- コードの式パターンで先読みを検出しようとした → 正しいコード11箇所を誤検出。
  同じ式が正しい文脈でも現れるため、式だけでは正誤を区別できなかった
- 報告の範囲表現を検証しようとした → 15件中ほとんどが誤検出。
  範囲は分析者が選んだ部分集合に対するもので、正当な部分集合を機械で列挙できなかった

どちらも**設計を変えて目的を達成した**（計算を1箇所に集約して「集約が破られていないか」だけを
検査する／測定スクリプト側に範囲を出力させて実在値との照合に落とす）。

したがって golden task には**必ず2種類のfixtureを置く**:

```yaml
checks:
  - evaluator: <id>
    fixture: .os/golden_tasks/fixtures/<bad>/    # 検出力: 欠陥を再現した状態
    expected: FAIL
  - evaluator: <id>
    fixture: .os/golden_tasks/fixtures/<good>/   # 偽陽性でないこと
    expected: PASS
  - evaluator: <id>                              # 本体が清潔なまま保たれること
    expected: PASS
```

## 独立性の規約（このSkillが生成する評価の実行方法）

- 評価の実行は `node cli/index.js evaluate --task <id>` のみ
- llm_judgeの判定は**生成エージェントとは別の新規サブエージェント**が、
  生成されたbriefing（`.os/briefings/eval-*.md`）だけを読んで行う
- 決定的評価のFAILはLLM判定で覆せない（コアが強制）

## Token Ledger

    node cli/index.js ledger add --purpose build-evaluation-model --tier T2

トークン数は任意。見積りを台帳に入れない（実測値があるときだけ
`--tokens-in <n> --tokens-out <n> --measured`）。
