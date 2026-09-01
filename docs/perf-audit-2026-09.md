# autopoiesys 性能監査 2026-09-01（T017）

結論: 目的接地の設計（verbatim焼き込み・plan事前判定・briefing独立判定）は健全。一方で
**(1) トークン推定の3〜4倍過小 (2) 教訓想起の無上限 (3) 警告の全文再掲 (4) llm_judge再判定の超過
(5) 空回りするコスト台帳 (6) 存在しない評価器idを受理する登録** が、品質に寄与しないトークンと
知性を疑わせる挙動の主因。定量主張は末尾の検証ログと宣言（C0001〜C0008）で執行可能な形に接地した。

## B/C: 無駄トークン・冗長挙動
1. **トークン推定が length/4**（core/util.js:22）。日本語≈1字1トークンのため3〜4倍過小。briefing予算・
   digest予算・research_tokens・「Context削減」の自己検証が全て甘く狂う。→ CJK文字は1字1トークンで数える推定に置換。
2. **教訓想起に閾値・上限なし**（core/experience.js lessonsFor: score>0で全件。2-gram語一致1点でも届く）。
   T017登録時点で全23教訓中15件が届き（context_log.jsonl機械記録）、うちS0176/S0187/S0207等は他リポジトリ専用。
   監査中に教訓を1件足すと想起は16/24件に増えた — 教訓数に比例する線形増加のその場の実演。
   → 類型/scope一致なしの純語一致はscore≥2かつ上位7件程度に制限し、省略件数を1行で開示。
3. **未処理警告の全文再掲**: printHints（cli/index.js:86）の呼び出しが14コマンドに埋まれ、未処理の警告を
   毎回全文出力する（本セッション実測: 警告8+ヒント1で約1,250字/回）。毎回同じ警報は黙殺を学習させる。
   → セッション内初回のみ全文、以後「未処理の警告8件（詳細: agenda）」の1行に畳む。
4. **llm_judge再判定の超過**: T017以前の台帳225行で、LLM系評価器46ペアに87回判定＝超過41ラウンド
   （UNCERTAIN 11・FAIL 7）。判定サブエージェント1回の実測42Kトークン（T017計画判定・T1/haiku）から
   超過分は**推計**約1.6M。原因は教訓化済み（S0157/S0186/S0195/S0205）だがコードパス未反映。
   → (a)実装artifactなしタスクへのedge_case_coverage宣言をtask new時に警告
   (b)複数rubricの1サブエージェント束ね判定を許す（独立性の要件は生成者からの独立であり、判定者間ではない）。
5. **コスト台帳が空回り**: costs.jsonl（T017以外49行）に実測（measured）0件・直近はtokens 0/0の行のみ。
   growth系評価器が空データを読む。→ サブエージェントusage実測だけを--measuredで記録し、実測なしの0行は書かない。
6. **儀式コストの床**: 小タスクでもCLI約11回+サブエージェント2体以上（llm_judge+experience audit）
   ≈**推計**60〜100Kトークン。→ experience auditもllm_judge同様、較正実績による抜き取りにする。

## A: 目的逸脱・知性を疑わせる挙動
7. **存在しない評価器idの受理**: `task new --evaluators llm_judge`（method名）が登録に成功し、evaluate時に
   初エラー（T017で実証）。宣言と検証の分離＝S0158と同型。→ 登録時に loadEvaluatorDef で即時検証。
8. **想起ノイズによる誤適用リスク**: (2)(3)は「本当に効く教訓・警告の黙殺」を学習させる — 知性の劣化経路。
9. **playbookのscope汚染**: get_repo_playbook scope=autopoiesys 12件中4件以上が他プロジェクト
   （notahotel-api / sw-kpi-dashboard）向け。→ 該当memory由来Statementのscope付け直し。
10. **原文接地は本日から有効**: verbatim保持は17タスク中T017のみ（制度が本日導入）。briefingの原文照合・
    plan事前判定の経路は現物確認済み（core/evaluate.js:464-479）。新規タスクの自己参照は塞がれている。

## 検証ログ（コマンド → 実出力の要点。いずれも exit 0）
- `grep -n 'return Math.ceil(str.length / 4)' core/util.js` → `23:  return Math.ceil(str.length / 4);`
- `node -e "<context_logからT017初回digestを抽出>"` → `digest 2026-09-01T11:56:59Z lessons: 15 S0153,...,S0205` /
  S0212追加後の再digest → `lessons: 16`
- `grep -c 'printHints(osDir);' cli/index.js` → `14`（定義行を除く呼び出し箇所数）
- `node -e "<log.jsonlをtask!==T017で集計>"` → `LLM判定行: 87 / deterministic行: 138`・`2回以上判定されたペア: 25/46`・
  `超過ラウンド合計: 41`・`verdict分布: PASS 190 / FAIL 23 / UNCERTAIN 12`
- `node -e "<costs.jsonl集計>"` → `rows: 49 measured: 0 estimated: 49`
- `node cli/index.js query get_repo_playbook --param scope=autopoiesys` → `total: 12`（うちnotahotel-api/sw-kpi言及4件）
- 判定1回の実測: T017計画判定の完了通知 `subagent_tokens: 42157`（tool_uses 3・T1/haiku・briefing 8,036 bytes）

## 前提の棚卸し
- 判定1回42Kトークンは標本1による**推計**の基礎。超過1.6M・儀式コスト60〜100Kも概算（出所: 測定+自分の外挿）。
- 会話全体の実トークンは未計測。CLI出力浪費はバイト実測からの換算（出所: 測定）。
- claims/較正制度は本日導入で標本0。制度自体の有効性は本監査では**評価できない**（出所: 台帳の事実）。
- 「修正は含めず報告まで」は依頼文「見直しを行う」からの解釈（出所: 自分で決めた。採否はユーザー判断）。
