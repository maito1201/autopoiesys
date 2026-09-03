#!/usr/bin/env bash
# Claude Code の実行ログから、本人が打った短い平文だけを日付付きで取り出す。
# 訂正・不満・差し戻しは、貼り付けた文書ではなく短い一言として残っているため、
# メッセージ全体の長さで絞れば大半のノイズが落ちる。判断（何が訂正か）は読む側がする。
# 使い方: corrections.sh <~/.claude/projects 配下のディレクトリ>... [--max 300] [--since YYYY-MM-DD]
set -u
max=300; since="0000-00-00"; dirs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --max) max="$2"; shift 2;;
    --since) since="$2"; shift 2;;
    *) dirs+=("$1"); shift;;
  esac
done
[ ${#dirs[@]} -gt 0 ] || { echo "usage: corrections.sh <project-log-dir>... [--max N] [--since YYYY-MM-DD]" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq が必要" >&2; exit 2; }
for d in "${dirs[@]}"; do
  proj=$(basename "$d" | sed 's/^-Users-[^-]*-[^-]*-//')
  for f in "$d"/*.jsonl; do
    [ -f "$f" ] || continue
    jq -r --arg p "$proj" --argjson max "$max" --arg since "$since" '
      select(.type=="user")
      | .timestamp[0:10] as $day
      | (.message.content
         | if type=="string" then .
           elif type=="array" then map(select(.type=="text") | .text) | join(" ")
           else empty end) as $t
      | select($t | length > 6 and length <= $max)
      | select($t | test("^\\s*[<\\[/#|`-]") | not)
      | ($t | gsub("\n+"; " / ")) as $t
      | select($day >= $since)
      | "\($day)\t\($p)\t\($t)"
    ' "$f" 2>/dev/null
  done
done | sort -u
