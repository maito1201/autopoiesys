#!/usr/bin/env bash
# autopoiesys のスキル4本を ~/.claude/skills に symlink する。一度だけ。以後どのリポジトリでも /init-os が使える。
set -eu
AP="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p ~/.claude/skills
for d in "$AP"/.claude/skills/*/; do
  name=$(basename "$d")
  ln -sfn "${d%/}" ~/.claude/skills/"$name"
  echo "~/.claude/skills/$name -> ${d%/}"
done
echo "新しいスキルは Claude Code の次回セッション起動から /コマンドとして使える"
