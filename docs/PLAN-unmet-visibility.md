# PLAN: F010 — 目的層の基準が「測って不合格」のときに見えなくなる

事前固定。着手前に判定基準と手順を固定する。

## 症状（実測）

sc-005（知性のoutcome）の最新verdictは `FAIL / reason: insufficient_sample` である。
ところが T013 でその evaluator を一度実行した直後から、

- `gap --criteria-only` は sc-005 を **AVAILABLE**（「evaluatorが実在しverdict記録あり」）に分類し、
- `next-action <task>` の **caveats から消え**、
- `agenda` の項目（unmeasured_criterion）からも**消えた**。

「一度も測っていない」より「測って不合格」の方が見えなくなる。

## なぜ起きたか

`core/gap.js` の `goalCriteriaGaps` は verdict の**件数**しか見ておらず、内容を見ていない。
分類の階段が「unbound → evaluator不在 → verdict件数ゼロ → それ以外は AVAILABLE」で、
最後の枝に「測ったが不合格」が吸い込まれる。`unmeasuredCriteria`（caveatsの供給元）も
MISSING / UNVERIFIED しか拾わない。

これは **F005 と同型の再発**である（基準を束縛した瞬間に caveats が消え、目的未達のまま
「完全に DONE」と言うようになった）。今回は束縛ではなく**実測**が引き金になった。

## 変更

1. `core/gap.js`: 分類に `UNMET` を追加する。束縛evaluatorの**最新verdictがFAIL**なら UNMET。
   `why` に fail の reason と ts を含める
2. `core/evaluate.js`: caveats の供給元を「測れていない基準」から
   「測れていない基準 **と** 測って不合格の基準」に広げる。両者は文言で区別する
   （「測定できていない」と「測定した結果、不合格」を同じ語で呼ばない）
3. `core/agenda.js`: UNMET の基準を項目として出す。スコアは unmeasured より高くする
   （測って落ちている基準は、測っていない基準より確度が高い）。
   action は fail_reason で分岐: `insufficient_sample` なら「直せ」ではなく
   「標本・観測を足せ」（E3の写像と同じ規律）
4. 予防資産: 検出器 `scripts/check-goal-unmet-visible.js` — fixture の `.os` に対して
   gapAnalysis を走らせ、最新verdictがFAILの基準が UNMET として出るかを検査する。
   golden `gt-011` に両方向の fixture を付ける
5. SCHEMA.md の Gap Analysis の分類一覧に UNMET を追記

## 合格条件（結果を見る前に固定する）

- `npm test` 全件 PASS（現状 238 + 新規分）
- `node cli/index.js regression` pass、golden 全件 PASS、failure_lint 0、check_errors 0
- **live での確認**: 修正後に `next-action T012` の caveats に sc-005 が
  「測定した結果、不合格」として現れること。`agenda` にも項目として現れること
- **検出力の実測（両方向）**: 新検出器が、FAILのverdictを持つ fixture で NG、
  PASSのverdictしか無い fixture で ok を返すこと
- **反証**: この修正が見かけだけなら、`gap` の分類だけ変わって caveats / agenda は
  変わらないはずである。3つとも live で目視確認し、出力を報告に貼る

## 前提の棚卸し（着手前）

| 前提 | 出所 | 対処 |
|---|---|---|
| 「最新verdict」は evaluations/log.jsonl の当該evaluatorの最終行 | 自分で決めた | 既存の `latestVerdicts` と同じ規則に揃える。タスクを跨いだ最新である点は報告に書く |
| UNMET は MISSING/UNVERIFIED より高い優先度に置く | 自分で決めた | 測って落ちている方が確度が高いという判断。誤りなら重みを下げればよい（重みは測定に基づかない暫定値であると agenda 自身が宣言している） |
| sc-005 の FAIL は「直す」対象ではなく「基質を足す」対象である | 測定（fail_reason: insufficient_sample） | 検出器自身がそう宣言している。agenda の action をそれに従わせる |
| gitコミットはユーザーが行う | ユーザー指定 | 従う |

## 変更履歴（着手後の逸脱）

**事前固定の変更4「検出器 `scripts/check-goal-unmet-visible.js` + golden `gt-011`」を取り下げた。**

理由: この不変条件は**コードの性質**であって**データの性質**ではない。golden task の
検出力 fixture は「悪いデータ」を用意して検出器が NG を出すことを示す仕組みだが、
今回の欠陥は入力データではなく分類ロジックの側にあった。現在のコードに対しては、
どんな fixture を与えても NG は出ない（出るとすればコードが間違っているときだけで、
それは fixture では作れない）。

無理に fixture を作るなら、fixture の中に旧ロジックの複製を置くことになる —
それは F008（fixture が実装を影で置き換える）を自分で再現する行為である。

代わりに `tests/gap-unmet.test.js` で**分類・caveats・agenda の3層すべて**を固定した。
事前固定に書いた反証（「分類だけ変わって caveats / agenda が変わらない」）は、
この3層のテストと live 出力の目視で確認する。
