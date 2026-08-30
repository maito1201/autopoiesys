# 事前固定: 日々の成長ループを閉じる

実装前に固定する。結果を見てから書き換えない。変更は末尾の変更履歴に理由つきで追記する。

## 何を作るか

仮説: 今のClaudeは、それ単体では「特定ドメインのタスクを日々行い、記憶と経験を
再利用して、人間を超える知性的行動に至る」という目的行動において機能が欠けている。
autopoiesysはその欠損を埋める外部装置である。

この欠損を埋めるループはこうなる。

```
タスクをやる → 経験が1行の教訓に蒸留される → 次に同種のタスクをやるとき、
教訓が黙っていても届く → 使った教訓が効いたか外れたかが記録される →
外れた教訓は自動で引っ込む → 回数を重ねるほど良くなっているかを数字で見る
```

今のリポジトリには部品（World Model・評価・Failure・決定と方針）はあるが、
**このループそのものが閉じていない**。閉じるために5つの器官を足す。

| 器官 | 埋める欠損 | 実装 |
|---|---|---|
| タスク類型 | 「日々同じ種類の仕事をしている」ことを機械が知らない | task に class（1行の抽象）と fingerprint |
| 自動想起 | 自分が何を思い出せていないかを知らない | task new / task brief が過去の同種タスク・教訓・方針・失敗を**黙っていても**出す |
| 蒸留 | 経験が生ログのまま腐る | type: lesson（本文+適用条件+類型）。タスク完了時に「何を学んだか」の開示を強制 |
| 書き戻し | 使った経験が効いたかを知る経路が無い | consolidate で helped / misled を記録。misledは evidence の counters で教訓に張る |
| 成長の実測 | 良くなっているかが主張のまま | 類型ごとに 試行ごとのFAIL数・トークン・教訓数 の系列を出す |

加えて「指示なしで次の仕事を出す」器官（agenda）を足す。未解決のUnknown・
反証された教訓・未消化のFailure・測れていない成功基準から、次にやるべき仕事を
決定的に並べて返す。

## 決めごと

- 教訓の蒸留（何を1行にするか）は書き手がやる。機械は届ける・照合する・数えるだけ
- consolidate が強制するのは**開示**であって内容ではない。「学びなし」も理由つきで許す
- 外れた教訓は counters の証拠が付いた時点で想起から外す（方針の自動撤回と同じ規律）
- トークン節約は目的にしない。良い設計の帰結として安くなるだけ

## この設計が誤りなら何が観測されるか

1. **類型が再来しない**（毎回違うclassが付く）→ 抽象の粒度を書き手が扱えない
2. **届いた教訓の misled が helped を上回る** → 蒸留が害
3. **同じ類型の試行を重ねてもFAIL数・ループ数が減らない** → 「経験の再利用で成長する」
   仮説がこの装置では成立していない

判定材料は growth の系列と lesson feedback の集計だけ。**教訓の件数・想起の回数は
成功指標にしない**（たくさん思い出したことは、役に立ったことを意味しない）。
試行が3回未満の類型では傾向を語らない。

## 実装対象

- `core/taskclass.js`（新規）: classFingerprint / suggestClasses / recordConsolidation / unconsolidatedDone
- `core/experience.js`（新規）: recordLesson / digest（自動想起の中身）/ feedback / contested
- `core/growth.js`（新規）: 類型ごとの試行系列
- `core/agenda.js`（新規）: 指示なしの次の仕事
- `core/store.js`: type lesson と when / task_class（実装済みの土台）
- `core/evaluate.js`: task の class / class_fp（実装済みの土台）
- `cli/index.js`: task new --class / task brief / task consolidate / agenda / growth
- `core/context.js`: 同一類型のlessonをReasoning Contextで優先
- `core/regression.js`: 完了済みなのにconsolidate未記録のタスクを警告
- SCHEMA.md / docs/DESIGN.md / docs/USAGE.md / skills/run-task
- tests: taskclass / experience / growth / agenda

## 検証手順（この順で実行し、報告に転記する）

1. `node --test tests/*.test.js` 全通過
2. `node cli/index.js regression` golden全通過
3. `node cli/index.js validate` / `check` errors 0
4. 一時OSでループを2周する: 類型Xのタスク1回目→教訓を残す→2回目のtask newで
   その教訓が黙って届く→helped/misledを記録→growthに2試行の系列が出る→
   agendaが何かを返す
5. artifactを**全部登録してから** evaluate（前回の抜けの再発防止）
6. 独立サブエージェントの判定 → next-action

## 変更履歴

（実装前の版）
