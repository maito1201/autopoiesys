---
name: decompose-goal
description: GoalからRequired Intelligence（Capability・Decision・Knowledge・Evaluation）を導出してIntelligence Graphに落とし、gap分析で現在のOSに何が有り何が無いかを分類する。CONCEPTv2 §5-6の中核。
---
<!-- autopoiesys:generated source=skills/decompose-goal/SKILL.md — skills sync の生成物。編集は正本側に行う -->

# decompose-goal

「この目的を達成するために、どんな知性が必要で、何が不足しているか？」に答えるSkill。
**分解の推論はLLMが担うが、結果は必ずグラフ（capabilityノード＋relationship辺）に落とす。
一回限りの賢い回答をチャットに書いて終えることを禁止する**（CONCEPTv2 §7）。

## 手順

### 1. Goalのノード化

goal.yaml を読み、World Modelに goal ノードが無ければ起票する（既にあれば再利用）:

    node cli/index.js statement add "<goal.yamlのgoal原文>" --type goal --source goal.yaml --method human

### 2. 分解（LLM推論）

Goalから次の階層を導出する（CONCEPTv2 §5）:

    Goal → Required Capabilities → Required Decisions → Required Knowledge
         → Required Evaluations → Required Actions → Required Feedback

規律:
- Capabilityは「OSが持つべき能力」の単位で3〜10個程度。細かすぎる分解はしない
- 各Capabilityについて「この能力の完了・品質を誰が判定するか」を必ず考える
  （評価器に接地しない能力はGap分析でMISSINGになる — それが正しい挙動）
- 既存の資産（`node cli/index.js query` の一覧、evaluators/、queries/）を先に見て、
  既にあるものへの束縛を優先する。無いものは無いまま出す（捏造しない）

### 3. グラフへの接地

分解結果を構造化findingsにまとめ、compileで接地する:

```json
{
  "claims": [
    {"type": "capability", "body": "変更リスクの評価", "status": "hypothesis", "confidence": 0.8,
     "tags": ["decomposition"]},
    {"type": "relationship", "subject": "<goalノードID>", "predicate": "requires",
     "object": "<capabilityノードID>", "body": "目的達成には変更リスク評価が必要",
     "status": "hypothesis", "confidence": 0.8},
    {"type": "relationship", "subject": "<capabilityノードID>", "predicate": "evaluated_by",
     "object": "evaluator:tests_pass", "body": "リスク評価の一部はテストで判定される",
     "status": "fact"}
  ]
}
```

    node cli/index.js compile --file <findings.json>

- 端点は同一findings内のノードID（採番される場合は2回に分けて投入する）か、
  型付き参照（`evaluator:` `query:` `golden_task:` `task:` `failure:` `skill:`）
- **実在しない束縛先はコアが拒否する。** 拒否されたら評価器を捏造せず、束縛なしで出す
  （MISSINGとして可視化されるべき情報だから）

### 4. Gap分析（決定的）

    node cli/index.js gap --goal <goalノードID>

分類の読み方:

| 分類 | 意味 | 次の一手 |
|---|---|---|
| AVAILABLE | 接地・証拠・確信度に問題なし | — |
| MISSING | 束縛が無い/束縛先が不在（**知識不足でなく構造不足**の可能性） | 評価器・Queryを作る or さらに分解 |
| UNVERIFIED | 実在するが一度も検証されていない | 実行して verdict を残す / 証拠を集める |
| UNCERTAIN | 仮説のまま / 確信度不足 | Research / Experiment |
| CONFLICTING | 矛盾する証拠が併存 | RESOLVE_CONFLICT |
| STALE | 検証が古い / 束縛先が置換済み | 再検証して supersede |

MISSINGをUnknownとして台帳に残す場合（推奨）:

    node cli/index.js gap --goal <id> --assert

### 5. 報告と承認

分解結果（capability一覧とGap分類の集計）をユーザーに提示し、承認を得る。
**MISSINGを埋める作業（評価器作成等）は承認後に別Skill（build-evaluation-model等）で行う。**

### 6. Token Ledger

    node cli/index.js ledger add --purpose decompose-goal --tier T2

見積りは台帳に入れない（API実測値があるときだけ `--tokens-in <n> --tokens-out <n> --measured` を付ける）。

## 禁止事項

- 分解結果をチャット回答だけで終える（グラフに落ちていない分解は次回の推論に使えない）
- 存在しない評価器・Queryへの束縛を作るためにファイルをでっち上げる
- Gap分類を自分の推論で上書きする（分類は決定的コアの仕事。異議があれば
  グラフ側を修正して再実行する）
- 一度の分解で完璧を目指す（§26⑥ — 分解自体もタスクと失敗から進化する）
