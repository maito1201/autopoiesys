#!/usr/bin/env bash
# 覚え書きの入口が小さく保たれているかを見る。毎回読み込む文は、長いほど守られにくくなるため。
set -u
K="${1:?usage: check.sh <覚え書きの場所>}"
ng=0
[ -f "$K/MEMORY.md" ] || { echo "NG: MEMORY.md が無い（/autopoiesys:init-memory で作る）"; ng=1; }
[ -f "$K/MEMORY.md" ] && [ "$(wc -l < "$K/MEMORY.md")" -gt 60 ] && { echo "NG: MEMORY.md が60行を超えた（細かい事は notes/ へ下ろす）"; ng=1; }
[ $ng -eq 0 ] && echo "OK"
exit $ng
