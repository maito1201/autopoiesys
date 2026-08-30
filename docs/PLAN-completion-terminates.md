# 是正したタスクが完了に到達できるようにし、スキップを台帳に残す

F012（承認済み提案 `.os/proposals/F012-completion-loop-terminates.md`）の適用と、
T017の独立監査が見つけた観測の穴を同じ変更で塞ぐ。

## 直す2つの欠陥

1. **是正した仕事ほど完了から遠ざかる**（F012-1）。`escalationSignals` の往復検出は
   verdictの並びだけを見て、判定の間に成果物が変わったかを見ない。`run-task` 手順6が
   指示する `FAIL → 修正 → PASS` を通ったタスクは、以後どの状態でも
   `RESOLVE_CONFLICT` から出られない（実測: T016は全判定の直前に成果物の再登録があり、
   同一状態での食い違いは0件なのに RESOLVE_CONFLICT のまま）。
2. **節約を主張する装置が節約の実績を記録しない**（T017の監査で判明）。
   `skipped: unchanged`（再判定の停止）は台帳に何も書かないため、
   何回の再判定（1本45k〜128kトークン）を止めたかが実測できず、
   「実際に通した」という申告も独立監査が裏づけられない（S0019・S0063 が insufficient）。

## 何を変えるか

1. **往復の判定を「いまの状態を見た判定どうし」に限定する。**
   最後の成果物登録（`artifacts[].ts` の最大値）以降に記録されたverdictだけを対象にし、
   その範囲で同じevaluatorがPASSとFAILの両方を出していたら `conflicting_evidence` とする。
   台帳にある時刻だけで決まる決定的な判定で、新しい申告を必要としない。

   **提案の第2項（`--resolved-conflict` で解消を宣言する経路）は作らない。**
   解消の宣言は「解消したと言えば解消になる」自己申告であり、この範囲は
   成果物の再登録＋新しい判定という既存の機械記録で表現できる。採らない理由をここに残す。
   検出力は落ちない — 同じ状態のまま判定を引き直してPASSを得ても、
   食い違ったFAILは同じ範囲に残るため、矛盾は消えない。

2. **再判定のスキップを `observations/context_log.jsonl` に1行残す**
   （`kind: briefing_skipped`）。節約の回数が数えられ、スキップ経路を通った事実が
   独立監査から見える。

3. **是正の系列と同一状態の食い違いを区別する検出器**（`scripts/check-completion-terminates.js`）と
   golden task（fixture付き）を追加する。F012の受け入れ条件「片方だけ通る実装では赤くなること」を
   満たすため、fixtureは2方向を持つ。

**`intelligence_trend` は変更しない**（提案の第3項）。自分を不合格にしている基準を、
自分がブロックされている最中に緩めるのは、証拠を見てから基準を動かす行為である。

## 受け入れ条件（実装の結果を見る前に固定する）

1. FAIL → 成果物の登録 → PASS を通り、最新verdictに実FAILが無いタスクの `next-action` が
   `RESOLVE_CONFLICT` を返さない
2. 最後の成果物登録以降に同じevaluatorのPASSとFAILが並ぶタスクは、いまと同じく
   `RESOLVE_CONFLICT` になる（検出力を落とさない）。同じ状態のまま判定を引き直しても解けない
3. `skipped: unchanged` のとき `context_log.jsonl` に `kind: briefing_skipped` が1行増え、
   briefing本体は生成されない
4. 新しい検出器が、是正済みで止まった状態（`last_action: RESOLVE_CONFLICT` なのに
   同一状態の食い違いが無い）と、食い違いを抱えたまま完了と記録された状態
   （`last_action: DONE` なのに同一状態の食い違いがある）の両方をFAILにする。
   健全なfixtureではPASSする
5. `node --test` 全件・`regression` 全件（golden 13件）・docs-drift・skill-commands が通る
6. 実測: この変更後に T016 の `next-action` が RESOLVE_CONFLICT から出ること。
   **ただしDONEになってはいけない** — T016の `intelligence_trend` は
   FAIL(insufficient_sample) であり、正しい行き先は COLLECT_EVIDENCE である。
   DONEになったら完了認定を緩めた証拠であり、失敗と書く

## 前提の棚卸し

| 前提 | 出所 | 対処 |
|---|---|---|
| 残タスクを進める（F012適用を含む） | ユーザー指定 | 固定制約 |
| 完了の敷居は下げない。直すのは往復の**区別**だけ | 提案（F012、著者は当該欠陥にブロックされた実行者） | 受け入れ条件6で「DONEになったら失敗」と事前に書いて縛る |
| 提案の第2項は採らない | 自分で決めた | 理由を上に明記した。承認者が別案を採ってよいと提案自身が許している範囲 |
| `intelligence_trend` には触らない | 提案の第3項 | 固定制約として扱う |
| 同一状態の食い違いは「最後の成果物登録以降」で判定できる | 自分で決めた | load-bearing。受け入れ条件2の逆方向fixtureで測る |

## 変更履歴

- 初版: 実装前に事前固定した。
