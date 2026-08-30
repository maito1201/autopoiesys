# PLAN: 自己申告に依存している箇所を機械記録に接地する

事前固定。**変更に着手する前に**判定基準と手順をここに固定し、`task plan` でハッシュを台帳に残す。

## 何がこの仕事を要求したか

- agenda 項目5 = 未解決Unknown **S0035**「helped/misled申告の真偽を検証する独立経路が無い
  （申告者=実行者のまま）」
- 同じ監査で見つけた、agenda 自身の2つの欠陥（下記 D2/D3）

## 直そうとしている欠陥（着手前に観測した事実）

| # | 欠陥 | 観測 |
|---|---|---|
| D1 | `--origin agenda:X` は文字列として保存されるだけで、X が実在するか誰も照合しない。sc-007（自発的推進）の検出器は正規表現で接頭辞を見るだけ | `scripts/check-self-directed.js` の `SELF = /^(agenda:\|failure:\|lesson:)/`。任意の文字列で合格する |
| D2 | agenda は `.os/proposals/` のファイルを無条件に「未消化の提案」として挙げる。適用済みでも消えない | F005 は state=implemented（assets記録あり）なのに `proposals/F005-upgrade.md` が agenda 7位に出続ける |
| D3 | agenda は「その項目に既に着手しているか」を知らない。着手中の項目も未着手と同じ順位で出る | `core/agenda.js` はタスク台帳を origin で引かない |
| D4 | consolidate の helped/misled は申告のまま。無申告（配信されたのに処遇なし）は検出されるが、**申告の真偽**を独立に見る経路が無い | S0035。`experience.feedback` は provenance.source='consolidate'（申告者=実行者）で evidence を書く |

## 方針（S0018 との関係）

「検出器は内容を強制せず開示だけを強制する」に反しないこと。

- D1 で強制するのは **参照の解決可能性**であって、由来が正しいかではない。
  「agenda が挙げた項目である」は台帳に実在する記録との照合で決まる事実であり、
  どの仕事をすべきかを機械が決めるわけではない
- D4 で作るのは **判定の経路**であって、判定の中身を機械が決めるのではない。
  真偽の判断は、会話履歴を持たない独立判定者が機械記録だけを見て行う

## 変更（この順に行う）

1. **origin の機械解決** — `core/agenda.js` に `resolveOrigin(osDir, origin)` を新設。
   `agenda:<ref>` は現在の agenda 項目に、`failure:<id>` は Failure 台帳に、
   `lesson:<id>` は type: lesson の Statement に解決する。`user` は解決不要。
   `task new` は OS 由来を名乗って解決できない場合 **登録時に失敗する**
   （evaluator の scope 未解決と同じ規律）。解決できた場合は
   `origin_verified: {kind, ref, via, ts}` をタスクに記録する。
2. **sc-007 の検出器を申告から記録へ** — `scripts/check-self-directed.js` は
   `origin_verified` を持つ完了タスクだけを数える。接頭辞だけの申告は
   「未検証の申告」として別枠で表示する（隠さない）。
3. **agenda の消化済み提案の退役** — ファイル名に含まれる Failure ID が
   terminal（implemented / accepted_risk）なら「未消化の提案」に出さない。
   ID を含まないファイルは判定不能として従来どおり出す。
4. **agenda の着手中表示** — 未完了タスクの `origin_verified.ref` と一致する項目に
   `in_flight: <task id>` を付け、スコアを 0.2 倍する（消さない。着手済みでも
   放置されていれば見える必要がある）。
5. **申告の独立監査経路（S0035）** — `experience audit <task>` が
   **機械記録だけ**（digest 配信ログ・artifact と ts・note・verdict と ts・plans・申告そのもの）
   から briefing を組み、会話履歴を持たない判定者に渡す。
   `experience audit-record <task> --lesson <id> --result supported|contradicted|insufficient`
   で結果を `observations/claim_audit.jsonl` に記録し、contradicted は
   provenance.source='experience-audit' の evidence（counters）として書き戻す。
   `growth` は申告数と独立検証数を分けて表示する。
6. S0035 を supersede する（「経路が無い」→「経路はある。実績は N 件」）。

## 合格条件（結果を見る前に固定する）

- `node --test tests/*.test.js` 全件 PASS（現状 222 件から、新規テスト分だけ増える）
- `node cli/index.js regression` の golden 全件 PASS・failure_lint 0
- **検出力の実測**（fixture で両方向を示す。片側だけでは検出器と呼ばない）:
  - D1: 実在しない agenda 項目を名乗る `task new` が失敗すること／実在する項目なら成功すること
  - D2: terminal な Failure の提案が出ないこと／非terminal なら出ること
  - D3: 着手中の項目が in_flight として降格すること／未着手なら降格しないこと
  - D4: audit briefing が機械記録だけを含み、自己申告の散文（report本文）を含まないこと
- **本体への初走行**（S0022）: 変更した検出器を live `.os` に一度走らせ、結果をそのまま報告する
- 通しの実行（S0019）: 単体テストではなく実際の CLI で 1 周（origin 付きで登録 → 蒸留 → 監査）
- 既存の振る舞いを壊さないこと: `validate` / `check` の errors 0、`skills sync --check` 同期済み

## 事前に決めた反証

この変更が「見かけだけの改善」である場合、次が観測されるはずである。着手後に必ず見る。

- **D1 が形式だけ**: 解決に成功しても、実際には agenda に何でも書けば通る
  → 反証テスト: 存在しない ref を渡して失敗することを実測する
- **D4 が独立でない**: briefing に実行者の自己申告の文章が混ざっていれば、
  判定者は結局申告を読んで判定する → briefing の生成物を実際に開いて、
  含まれるのが機械記録だけであることを目視で確認し、報告に引用する
- **sc-007 が自作自演**: 本タスク自身が origin_verified の第1号になる。
  これは「装置が自分に都合よく基準を満たした」ようにも見える。
  報告では、この仕事の**セッションの範囲はユーザーの指示で決まり、
  具体的な項目が agenda 由来である**ことを分けて書く。混ぜない

## 前提の棚卸し（着手前）

| 前提 | 出所 | 対処 |
|---|---|---|
| S0035 を解くのが今セッションで最も価値が高い | 自分で決めた（agenda が挙げた項目群からの選択） | agenda は S0035 を5位に置いた。1〜3位（sc-005/006/007 が測れていない）は基質の不足でありコードでは治らないと T010 が判定済み。選択の理由をここに開示する |
| 「独立」の担保は既存の独立判定者（会話履歴なしのサブエージェント）で足りる | 自分で決めた | 同一モデル・同一実行環境である点は限界として報告に書く。真に独立な検証は人間かモデル外の記録に依る |
| 由来の解決に失敗したら登録を止める（警告でなく失敗） | 自分で決めた | 既存の evaluator scope 未解決の規律に合わせた。誤りなら「登録は通るが origin_verified が付かない」に緩める |
| gitコミットはしない | ユーザー指定 | 従う |

## 変更履歴（着手後の逸脱。事前固定との差分をここに隔離する）

いずれも成果物の登録（artifact）より前に行い、`task plan` で追記登録した。

1. 監査層の置き場所を `core/experience.js` への追記から新モジュール `core/claimaudit.js` に
   変えた。experience.js が 500 行に迫り、蒸留・想起・監査が1ファイルに混ざるため。
2. 解決できる由来の種別に `unknown:` を足した（事前固定では agenda / failure / lesson / user）。
   リポジトリの作法 S0021 が「コアの変更は agenda項目・Failure・lesson・unknown のいずれかに
   由来させる」と定めており、unknown を解決できないのは接地の漏れである。
3. `skills/run-task/SKILL.md` に、由来の解決（手順1）と申告の独立監査（手順6.5）を書き足した。
   事前固定の6項目に入れていなかったが、経路を作って手順書に載せないと誰も通らないため。
4. **着手後に別の欠陥（F008）を発見したが、本タスクでは直さず起票にとどめた** —
   golden task の fixture が検出器スクリプトの複製を持っており、regression は複製を実行する。
   本体の検出器を書き換えても golden は PASS のままになる（実測済み）。
   事前固定した範囲を結果を見てから広げないため、別タスクとして扱う。
