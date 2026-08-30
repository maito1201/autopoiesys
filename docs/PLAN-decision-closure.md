# 能力の欠損の洗い出しと、決定の閉ループ・実行側Reasoning Contextの実装計画

対象: autopoiesys コア（このリポジトリ自身）
方針: 高度なタスクを遂行する能力の強化を最優先とし、トークン削減はその副産物としてのみ採る。

## 1. 洗い出し — 理想（CONCEPT / CONCEPTv2）と実装の乖離

判定は機械記録から採った。括弧内は一次記録。

| # | 理想 | 実装の状態 | 一次記録 |
|---|---|---|---|
| G1 | §8「決めた通りになったかを照合するループ」 | **一度も閉じていない**。決定6件すべて結果未記録、方針0件、方針の発火0回 | `decision list --unreviewed` が6件全件 / `metrics` の `policy.active=0, hits=0, outcomes.*=0` |
| G2 | v2 §8「Agentにはこの最小Subgraphだけを渡す」 | **判定者専用**。`buildReasoningContext` は `evaluate.js` の llm_judge briefing からしか呼ばれず、実行側に配るCLIが無い | `grep buildReasoningContext` の呼出元は core/evaluate.js のみ |
| G3 | §15 LLM Routing | `route` コマンドは実装済みだが**どのSkillからも呼ばれない** | `grep -rl "route" skills/` が0件 |
| G4 | v2 §5「Goal → Required Capabilities / Decisions / Knowledge」 | capabilityノードは7件あるが、`requires` の始点 `goal-eng` が現在状態に存在せず**孤立している**。現在のgoal（S0026）のgap分析には一件も入らない | `gap` の `required_total: 11`（全て type: goal_criterion） / `gap --goal goal-eng` は「goalノードが現在状態に存在しない」で失敗する |
| G5 | §14 Token Economics「成熟後: Cheap runtime」 | 実測値ゼロ。ledgerは全件が見積り、cheap-path被覆は0 | `metrics` の `tokens.measured: 0 / cheap_path_coverage: 0` |
| G6 | v2 §10「最も重要な実験」（Relation/Contextの価値の対照実験） | 未実行 | `docs/experiments/` に結果無し |
| G7 | §11 ループ（Execute→Evaluate→Next Action→Execute…） | 評価はタスク末尾の1回に固定されている（中間評価の経路が無い） | `verdicts.total 111 / tasks 15`、evaluate は完了報告直前の儀式として運用されている |

## 2. 優先度

優先度ポリシー（ユーザー指定）: **高度なタスクを遂行するための能力強化が最優先。能力が充分ならトークン削減も可。**

- **P0-1 = G1（決定の閉ループ）**: 「同じ判断の場に二度目に立ったとき、前回の選択と結果を思い出す」はClaude単体に欠けている機能の中核であり、その装置が実装されていながら**一度も動いていない**。使われない器官は資産ではなく負債である（§26⑥）。
- **P0-2 = G2（実行側のReasoning Context）**: 最小Subgraphを判定者にしか配っていない。実行側に配れると、サブエージェントへの委譲が「会話履歴を切り貼りする」から「機械が選抜した文脈を渡す」に変わる。能力（委譲）とトークンの両方に効く。
- P1 = G4（自OSへのGoal分解）・G7（中間評価）
- P2 = G3・G5・G6（いずれも計測とルーティング。能力が先という指定に従い後回し）

**今回実装するのは P0-1 と P0-2 のみ。** P1・P2 は実装せず、この文書に残す。

## 3. G1の原因（推測ではなくコードで確認した）

決定の閉ループは3本の線が繋がっていないために止まっている。

1. **結果を記録する契機が「同一 fingerprint の完全再来」しかない。** `decision.recall` は `situationFingerprint(situation, options)` の完全一致でしか過去を返さない。situation は書き手が1行で抽象した自由文なので、同じ場でも語が揺れれば一致しない。実際に6件の situation はすべて異なる fingerprint を持ち、再来は一度も起きていない。
2. **想起（digest）が決定を配らない。** `experience.digest` は過去タスク・教訓・確立済み方針・Failure・Unknown を押しつけるが、**決定そのものは配らない**。方針は「結果が met の反復」からしか生まれないので、結果が0件の現状では永久に空であり、決定の知識は実行者に一切届かない。
3. **完了時に結果の開示を求めない。** 教訓は `task consolidate` が無申告を許さない（未蒸留は警告が出続ける）。決定の結果には同じ強制が無い。

いずれも「押しつけ（push）がある層は動き、引きに来させる（pull）層は死ぬ」という同じ構造をしている。教訓層は配信56件の機械記録を持ち、決定層は0である。

## 4. 実装（事前固定）

### 4.1 決定の閉ループ（P0-1）

- `core/decision.js`: `recall` に**近傍照合**を足す。完全一致の fingerprint に加えて、situation の語（`context.extractTerms` の規則）が重なる過去の決定を `near` として返す。閾値は語一致1件以上、上位5件、完全一致分は除く。関連度と id で決定的に並べる。
- `core/experience.js`: digest に **「過去の決定」節**を足す。対象は (a) 同一 class_fp の過去タスクで下した決定、(b) タスクの語と situation が重なる決定。`situation → chosen（結果: met|unmet|unclear|未記録）` の形で出す。結果未記録があれば答え合わせのコマンド行を添える。
- `core/experience.js`: `logDigest` の行に `decisions: [id...]` を足す。**配信したのに結果が記録されなかった決定**を、実行者の申告に依存せず機械記録だけで数えられるようにする（教訓の helped/misled と同じ配線）。
- `core/regression.js` `maintenanceHints`: **完了したタスクで下した決定のうち結果が未記録のもの**を警告する。契機は日付ではなく「そのタスクが終わったこと」— 結果が知れるようになった瞬間である。
- `core/agenda.js`: 同じものを agenda 項目（kind: `unreviewed_decision`）として出す。OSが自分で要求する仕事にする。

強制するのは**開示**であって内容ではない。どの選択が正しいかはコアが決めない（S0018）。

### 4.2 実行側 Reasoning Context（P0-2）

- `cli/index.js` に `context` コマンドを新設:
  `node cli/index.js context [--task T] [--purpose "<何をするか>"] [--queries q1,q2] [--max-tokens N] [--param k=v]`
  `buildReasoningContext` を判定者用の経路と共有し、purpose を語の供給源に足す。
- 出力を `observations/context_log.jsonl` に `kind: "context"` として記録する（トークン経済の実測が判定者側だけに偏っているのを直す）。
- `skills/run-task/SKILL.md`: サブエージェントに仕事を委譲するときは、会話履歴ではなくこのコマンドの出力を渡す、と1行足す。

## 5. 受け入れ条件（結果を見る前に固定する）

1. `tests/decision.test.js`: 語の重なる別 situation の決定が `near` で返り、完全一致は `prior` に留まる。
2. `tests/experience.test.js`（または新規）: digest に決定が現れ、結果未記録なら答え合わせの行が出る。`context_log.jsonl` の digest 行に `decisions` が入る。
3. `tests/hints.test.js`: 完了タスクの結果未記録の決定が警告に出る。未完了タスクの決定では出ない。
4. `tests/context.test.js`: `context` コマンドが purpose だけでも Reasoning Context を返し、ログに `kind: "context"` が1行増える。
5. `node --test` 全件PASS、`node cli/index.js regression` 全件PASS、`skills sync --check` 通過。
6. 本体に対する初走行（S0022）: 実装直後に自分のOSで `decision recall` / `agenda` / `context` を実行し、実在の未記録決定6件が出ることを確認する。

## 6. 前提の棚卸し

| 前提 | 出所 | 対処 |
|---|---|---|
| 能力強化が最優先、トークン削減は能力が充分なときのみ | ユーザー指定 | 固定制約。P0の選定基準に使う |
| コミットはユーザーが行う / 外部依存を足さない / Skill駆動 | ユーザー指定 | 固定制約 |
| 「決定層が死んでいる」 | 測定（`metrics` / `decision list --unreviewed`） | 実測値をこの文書に転記済み |
| 「押しつけの層は動き、引きに来させる層は死ぬ」 | 自分で決めた（教訓層56件 vs 決定層0件の対比からの一般化。標本2） | 今回は採る。ただし一般則としては未検証であり、決定層に押しつけを入れても動かなければこの前提が誤りだったことになる。判定材料は「次の文脈で決定の結果が記録されるか」 |
| situation の粒度が細かすぎて再来しない | 測定（6件すべて別 fingerprint） | 近傍照合で緩和する。完全一致の意味は変えない |
| 実装するのは P0 のみで P1/P2 は今回やらない | 自分で決めた | 理由: 洗い出しの依頼に対し、能力に直結する2件を完了させる方が、7件を薄く触るより検証可能である。残りはこの文書に残して次の仕事にする |
| 中間評価（G7）が能力に効く | 自分で決めた仮説 | 今回は実装しない。Claude単体でも自己チェックできる領域であり、外部装置として補う必然性が他より弱いと判断した |

## 7. 実装中に増えた範囲（事前固定からの差分。結果を見てから受け入れ条件は動かしていない）

原因の調査中に、§3で挙げた2本の線よりも上流の欠陥が見つかったため、次の2点を実装に含めた。
どちらも §5 の受け入れ条件を緩めるものではない。

1. **判断の場の同定から選択肢を外した**（`situationFingerprint`）。第1版は options を鍵に
   混ぜており、同一文字列の situation でも `--options` の有無で別の場になっていた。
   台帳の決定はこれで全件が別の場として記録され、再来が一度も起きていなかった。
   台帳は追記専用なので、統合は読み出し側（`foldByFingerprint`）で situation から
   引き直すことで行う（過去の記録を書き換えない）。
2. **S0014 の結果が unmet だったため、F011 を起票した**。決定層が3文脈・15タスクを通じて
   一度も閉じなかったこと自体を Failure として台帳に載せ、`upgrade_proposed` まで進めた。
   予防資産（使われていない器官を名指しする仕組み）は `.os/proposals/F011-dead-organ-audit.md`
   に提案として置き、**適用はしていない** — 承認を経る設計を崩さないため。

## 変更履歴

- 初版: T016 の実装前に事前固定した。
- 第2版: 実装中に判明した上流の欠陥（場の同定に選択肢が混ざっていた）と、
  それに伴う F011 の起票を §7 として追記した。§5 の受け入れ条件は初版のまま変更していない。
