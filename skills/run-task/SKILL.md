---
name: run-task
description: 思考回路に沿って1つの依頼を遂行する。CIRCUIT.md を読み、瞬間0でアウトカムを確定し、瞬間ごとに読み、終わりに書き戻す。回路が無ければ init-os を提案する。回路は CLAUDE.md の1行で届くので、このスキルは明示的に通したいときに使う。
---

# run-task — 回路を通す

回路は CLAUDE.md の「思考回路:」の行が指す場所。無ければ作業を始めず `/autopoiesys:init-os` を提案する。
このスキルは回路に書いてあることを繰り返さない。やるのは回路を最初から最後まで通すことだけ。
autopoiesys は plugin として配布される。場所 AP はこの SKILL.md の2階層上（`<AP>/skills/<name>/SKILL.md`）。Claude Code なら `${CLAUDE_PLUGIN_ROOT}` と同じ。`scripts/` と `template/` はその直下。

## 手順

1. CIRCUIT.md と、hypotheses.md の未観測行を読む
2. 瞬間0: anti-bureaucracy（plugin で毎セッション届いている）の 1〜4 を書いて見せる。回路の「繰り返し出た未知」を先に見る。アウトカムが認められるまでアウトプットを書かない
3. 瞬間1: INDEX.md から1〜3枚を丸ごと読む。5枚読みたくなったら止まり、アウトカムを狭める
4. 瞬間2: 作る。anti-bureaucracy の 5〜7（字義との差分・形式との差分・反証）を書く。回路が指す moments/ を、その瞬間に丸ごと読む
5. 瞬間3: 報告。回路の「読む相手」に合わせる。hypotheses.md に反証を1行
6. 瞬間4: 分かったこと・訂正を topics/ moments/ の既存ファイルへ統合する。`"$AP/scripts/check.sh" <回路path>` を通す

## 禁止

- 回路を読まずに作り始めること。アウトカム確認前にアウトプットを書くこと
- 回路の外に記録を作ること（計画書・台帳・評価）。記録は成果物と hypotheses.md の1行だけ
- 回路にない瞬間を独自に足すこと。足したいなら `/autopoiesys:run-feedback` で回路を直す
