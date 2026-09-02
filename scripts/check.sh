#!/usr/bin/env bash
# 知識の器が官僚化していないかを見る。判定は wc と grep だけ。
set -u
K="${1:?usage: check.sh <knowledge-home>}"
ng=0
say(){ echo "NG: $*"; ng=1; }
[ -f "$K/INDEX.md" ] || say "INDEX.md が無い"
[ -f "$K/INDEX.md" ] && [ "$(grep -c '^- ' "$K/INDEX.md")" -gt 40 ] && say "INDEX.md の項目が40行を超えた（削る）"
for f in "$K"/moments/*.md; do
  [ -f "$f" ] || continue
  [ "$(wc -l < "$f")" -gt 30 ] && say "$(basename "$f") が30行を超えた（moment はチェックリストではない）"
done
for f in "$K"/topics/*.md; do
  [ -f "$f" ] || continue
  [ "$(wc -m < "$f")" -gt 9000 ] && say "$(basename "$f") が9,000字を超えた（分けるか削る）"
  grep -nE '^\- ' "$f" | grep -vE '^\S+:- \[(確認済み|要約|仮説) [0-9]{4}-[0-9]{2}-[0-9]{2}\]|^\S+:- \[未確認\]' | grep -vE '^[0-9]+:- [0-9]{4}-[0-9]{2}-[0-9]{2} ' | head -3 | sed "s|^|$(basename "$f") ラベル無し行: |"
done
pat='verdict|較正|evaluator|llm_judge|World Model|statement|briefing|\bS0[0-9]{3}\b|\bT0[0-9]{2}\b|【RQ'
hits=$(grep -rnE "$pat" "$K"/topics "$K"/moments 2>/dev/null | grep -v "撤回\|統治語彙" | head -5)
[ -n "$hits" ] && { say "統治語彙・内部参照が本文に残っている"; echo "$hits"; }
grep -rn '出典:' "$K"/topics 2>/dev/null | grep -v '^\S*:\[\^' | head -3 | sed 's|^|出典が本文にある: |'
[ $ng -eq 0 ] && echo "OK"
exit $ng
