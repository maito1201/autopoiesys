# PLAN: F009 — 「届いたが適用しなかった」を第一級にする

事前固定。着手前に判定基準と手順を固定する。

## 何がこの仕事を要求したか

- Failure **F009**（source: claim_audit）: 教訓が配信され適用場面もあったのに適用されず、
  consolidate の処遇（helped/misled の2値）に反例を記録する語が無い。実測2件
  （T011: S0036 を「適用機会なし」と処遇した同じ note で件数を誤記 / T012: 同じ S0036 が
  再配信された報告で検査件数を誤記）
- **goal監査003 の FAIL**: goal 本文「記憶と経験を再利用して」が sc-006 では「配信の機械記録が
  存在する」にすり替わっており、「適用」はどの基準にも束縛されていない。F009 が
  「全基準PASSのまま再利用不成立」の生きた反例
- **T014 監査の contradicted が露出させた欠陥**: contradicted の反証が**教訓に**張られるため、
  実行者の虚偽申告のせいで正しい教訓（S0061）が想起から除外された。
  外れたのは申告であって教訓ではない

## 変更

1. **`task consolidate --unapplied <ids> --unapplied-reason "<理由>"`**:
   第3の処遇「配信され、適用場面もあったが、適用しなかった」。理由必須（開示の強制であって
   適用の強制ではない）。教訓に極性リンクは張らない（教訓は正しい）。
   helped/misled/unapplied の重複は拒否。consolidated に `unapplied` / `unapplied_reason` を記録
2. **contradicted の意味論修正（core/claimaudit.js）**: 申告由来の極性辺
   （helped の supports / misled の counters）を撤回するのは維持。
   **教訓への新しい counters は張らない** — 罰するのは申告であって教訓ではない。
   虚偽申告の事実は claim_audit.jsonl と evidence（リンク無し or 撤回対象への言及）で残す
3. **S0061 の救済**: 修正後、T014 の監査で書かれた S0071（S0061 への counters）を
   supersede で撤回し、S0061 が想起に復帰することを確認する。
   これは記録の抹消ではない — S0071 の本文は「申告が食い違う」であり、教訓への反証として
   張られたのが誤配線だった。撤回の理由を supersede の本文に書く
4. **growth**: 「配信 N / 処遇 M（helped/misled/unapplied）/ 無処遇 K」を分母つきで表示
5. **sc-008 の新設（goal監査FAILへの応答）**: 「helped 申告のうち、独立監査で supported と
   判定された実績が存在する（適用の証拠は申告でなく監査記録で数える）」。
   検出器 `scripts/check-lesson-applied.js`（T0・claim_audit.jsonl を読む）+ golden gt-012
   （検出力 fixture 両方向）。**現在の live .os では PASS するはず**（supported 8件）—
   もし FAIL したらそれはそれで正しい表示である
6. SCHEMA.md / USAGE.md / run-task SKILL.md を同じ変更で更新

## 合格条件（結果を見る前に固定）

- `npm test` 全件 PASS（現状 243 + 新規分）・regression golden 全件 PASS・docs-drift 違反なし
- 検出力の実測（両方向）: gt-012 が supported 有り fixture で PASS / 無し fixture で FAIL
- unapplied の検証: 理由なしは拒否 / helped との重複は拒否 / 極性リンクが張られないこと
- contradicted の検証: 申告由来の辺は撤回されるが、教訓に新しい counters が**張られない**こと。
  misled の虚偽申告（counters の撤回）も対称に扱えること
- live での実測: S0071 撤回後、S0061 が想起（lessonsFor）に復帰すること
- **反証**: unapplied が「misled と言わない逃げ道」になっていないかは、
  unapplied の申告も experience audit の対象に含めることで監査可能にする
  （briefing に unapplied とその理由を載せる）

## 前提の棚卸し（着手前）

| 前提 | 出所 | 対処 |
|---|---|---|
| 教訓に極性を張ってよいのは「教訓自体が誤誘導した」ときだけ | 自分で決めた | S0061 の実例（正しい教訓が虚偽申告で引退）が根拠。誤りなら、虚偽申告を繰り返す教訓が想起に残り続ける — その場合は claim_audit の contradicted 回数を想起時に表示する対処がある（今回は表示のみ実装） |
| sc-008 は「監査で supported 1件以上」で足りる | 自分で決めた | 適用の質や頻度は測らない最小の束縛。goal監査が再びFAILを出したら広げる |
| S0071 の撤回は正当（誤配線の訂正であり記録の抹消ではない） | 自分で決めた | claim_audit.jsonl の contradicted 記録は残る。撤回するのは教訓への辺だけ |
| gitコミットはユーザーが行う | ユーザー指定 | 従う |
