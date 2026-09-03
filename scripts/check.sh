#!/usr/bin/env bash
# 思考回路が官僚化していないかを見る。判定は wc と grep だけ。
set -u
K="${1:?usage: check.sh <circuit-dir>}"
ng=0
say(){ echo "NG: $*"; ng=1; }
[ -f "$K/CIRCUIT.md" ] || say "CIRCUIT.md が無い（回路が無い。/init-os で作る）"
[ -f "$K/CIRCUIT.md" ] && [ "$(wc -l < "$K/CIRCUIT.md")" -gt 60 ] && say "CIRCUIT.md が60行を超えた（足さずに削る）"
[ -f "$K/CIRCUIT.md" ] && ! grep -q 'アウトカム' "$K/CIRCUIT.md" && say "CIRCUIT.md に瞬間0（アウトカムの確定）が無い"
[ -f "$K/INDEX.md" ] || say "INDEX.md が無い"
[ -f "$K/INDEX.md" ] && [ "$(grep -c '^- ' "$K/INDEX.md")" -gt 40 ] && say "INDEX.md の項目が40行を超えた（削る）"
[ -f "$K/hypotheses.md" ] || say "hypotheses.md が無い"
for f in "$K"/moments/*.md; do
  [ -f "$f" ] || continue
  [ "$(wc -l < "$f")" -gt 30 ] && say "$(basename "$f") が30行を超えた（moment はチェックリストではない）"
  grep -q "moments/$(basename "$f")" "$K/CIRCUIT.md" 2>/dev/null || say "$(basename "$f") を CIRCUIT.md が指していない（届かない瞬間）"
done
for f in "$K"/topics/*.md; do
  [ -f "$f" ] || continue
  [ "$(wc -m < "$f")" -gt 9000 ] && say "$(basename "$f") が9,000字を超えた（分けるか削る）"
  grep -nE '^\- ' "$f" | grep -vE '^\S+:- \[(確認済み|要約|仮説) [0-9]{4}-[0-9]{2}-[0-9]{2}\]|^\S+:- \[未確認\]' | grep -vE '^[0-9]+:- [0-9]{4}-[0-9]{2}-[0-9]{2} ' | head -3 | sed "s|^|$(basename "$f") ラベル無し行: |"
done
pat='verdict|較正|evaluator|llm_judge|World Model|statement|briefing|\bS0[0-9]{3}\b|\bT0[0-9]{2}\b|【RQ'
hits=$(grep -rnE "$pat" "$K"/topics "$K"/moments "$K"/CIRCUIT.md 2>/dev/null | grep -v "撤回\|統治語彙" | head -5)
[ -n "$hits" ] && { say "統治語彙・内部参照が本文に残っている"; echo "$hits"; }
grep -rn '出典:' "$K"/topics 2>/dev/null | grep -v '^\S*:\[\^' | head -3 | sed 's|^|出典が本文にある: |'
[ $ng -eq 0 ] && echo "OK"
exit $ng
