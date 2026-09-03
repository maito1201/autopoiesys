# autopoiesys — 思考回路の作り方

LLM エージェントに高度な仕事を任せられない原因は、知性の不足ではない。
判断の瞬間に知識が届かないこと。そして本当に求められている物を理解していないと気づきながら、字義通りに作り始めること（官僚主義）。
autopoiesys は、目的ごとに「いつ・何を読み・何を疑うか」を並べた思考回路を作り、スキルに依存しないファイルとして届けるための最小の道具である。

## 背骨 — anti-bureaucracy

官僚主義とは、ユーザーが本当に求めているものを理解していないと気づいているのに、確定済みとされた「何を作るか」に従って作り始めること。罪は気づきの握り潰しであり、理解の不足ではない。
だから作る前に、アウトカム（誰の何がどう変わるか）を人間と確定し、未知を現実（コード・データ・現場）で埋め、人間にしか埋められないものだけを聞く。アウトプットは現実との接触で見つける。判断ごとに反証（外れていたら何がいつ観測されるか）を残し、後日の観測だけを審判とする。
全文は `.claude/skills/anti-bureaucracy/SKILL.md`（60行以内）。回路の瞬間0はこれの写しであり、スキルを呼ばなくても効く。

## 何があるか

- `.claude/skills/anti-bureaucracy/` — 哲学。作る前に通る
- `.claude/skills/init-os/` — 回路を作る。アウトカム確定 → 広く集める（コード・Claude 実行ログ・Web）→ topics / moments に整理 → CIRCUIT.md を設計 → CLAUDE.md に配線
- `.claude/skills/run-task/` — 回路を通す。明示的に通したいときだけ。普段は CLAUDE.md の1行で届く
- `.claude/skills/run-feedback/` — 回路を直す。不満の一言から、どの瞬間で知識が届かなかったかを突き止めて修正する
- `template/` — 回路の初期形。CIRCUIT.md（瞬間の列）・INDEX.md（トピックの問い）・topics/（事実）・moments/（瞬間）・hypotheses.md（反証）。規約は template/README.md
- `scripts/install.sh` — スキル4本を `~/.claude/skills` へ symlink する。一度だけ
- `scripts/corrections.sh` — Claude Code の実行ログから本人の短い発話を日付付きで出す。訂正の束が瞬間の材料になる
- `scripts/check.sh` — 回路が官僚化していないかを wc と grep で見る

## 使い方

1. clone して `scripts/install.sh` を一度実行する（スキル4本を `~/.claude/skills` へ symlink）。以後どのリポジトリでも `/init-os` が使える。最初の問いは「何ができるようになりたいですか」
2. 以後は配線された CLAUDE.md の1行が、依頼のたびに回路を届ける。スキルは要らない
3. 結果が駄目なら `/run-feedback` に一言。回路が直る
