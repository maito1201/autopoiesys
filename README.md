# autopoiesys — 思考回路の作り方

LLM エージェントに高度な仕事を任せられない原因は、知性の不足ではない。
判断の瞬間に知識が届かないこと。そして本当に求められている物を理解していないと気づきながら、字義通りに作り始めること（官僚主義）。
後者を止めるのは別 plugin の [anti-bureaucracy](https://github.com/maito1201/anti-bureaucracy)。autopoiesys は前者を担う。目的ごとに「いつ・何を読み・何を疑うか」を並べた思考回路を作り、スキルに依存しないファイルとして届けるための最小の道具である。

## 背骨 — anti-bureaucracy（別 plugin に依存する）

作る前にアウトカム（誰の何がどう変わるか）を人間と確定し、未知を現実（コード・データ・現場）で埋め、人間にしか埋められないものだけを聞く。作った後に字義との差分・形式との差分・反証を書き、後日の観測だけを審判とする。
この60行の要求は anti-bureaucracy plugin がセッションの冒頭と各サブエージェントに注入する。autopoiesys はそれに依存し、回路の瞬間0と瞬間2は要求を写さず、「この目的で繰り返し出た未知」と「目的固有の瞬間」だけを持つ。
anti-bureaucracy だけを使うこともできる。手順は向こうの README。

## 何があるか

- `skills/init-os/` — 回路を作る。アウトカム確定 → 広く集める（コード・Claude 実行ログ・Web）→ topics / moments に整理 → CIRCUIT.md を設計 → CLAUDE.md に配線
- `skills/run-task/` — 回路を通す。明示的に通したいときだけ。普段は CLAUDE.md の1行で届く
- `skills/run-feedback/` — 回路を直す。不満の一言から、どの瞬間で知識が届かなかったかを突き止めて修正する
- `template/` — 回路の初期形。CIRCUIT.md（瞬間の列）・INDEX.md（トピックの問い）・topics/（事実）・moments/（瞬間）・hypotheses.md（反証）。規約は template/README.md
- `scripts/corrections.sh` — Claude Code の実行ログから本人の短い発話を日付付きで出す。訂正の束が瞬間の材料になる。jq が要る
- `scripts/check.sh` — 回路が官僚化していないかを wc と grep で見る

スキル・`template/`・`scripts/` は autopoiesys plugin として配布される。スキル内からは `${CLAUDE_PLUGIN_ROOT}/template/` と `${CLAUDE_PLUGIN_ROOT}/scripts/` がそのままを指す。

## インストール（環境で一度）

```bash
claude plugin marketplace add maito1201/anti-bureaucracy
claude plugin marketplace add maito1201/autopoiesys
claude plugin install autopoiesys@autopoiesys
```

autopoiesys は anti-bureaucracy に依存しているので、3行目で両方入る。1行目は依存先の marketplace を Claude Code に教えるためのもの。
Claude Code を起動し直すと、3スキルが `/autopoiesys:init-os` などのコマンドとして使え、anti-bureaucracy の要求が毎セッション届く。以後どのリポジトリでも同じ。

旧版の autopoiesys plugin を入れていた人は、`claude plugin update` では新しい依存が入らない。1行目のあと `claude plugin install autopoiesys@autopoiesys` を再実行すると anti-bureaucracy が一緒に入る。
Codex CLI では plugin 間の依存が無いので、2つとも入れる（`.codex-plugin/plugin.json` と `.agents/plugins/marketplace.json` を同梱）。anti-bureaucracy の hook は `codex` の `/hooks` で信頼してから効く。スキルは `$autopoiesys:init-os` のように呼ぶ。

```bash
codex plugin marketplace add maito1201/anti-bureaucracy
codex plugin add anti-bureaucracy@anti-bureaucracy
codex plugin marketplace add maito1201/autopoiesys
codex plugin add autopoiesys@autopoiesys
```

以前 `scripts/install.sh` でスキルを symlink していた人は、plugin 導入前に `~/.claude/skills/{anti-bureaucracy,init-os,run-feedback,run-task}` を削除する。置いたままにするとユーザースキルと plugin スキルの二重に読まれる。

## 使い方の流れ

1. 最初は `/autopoiesys:init-os`。最初の問いは「何ができるようになりたいですか」。回路が置き場に置かれ、CLAUDE.md に1行入る
2. 以後は配線された CLAUDE.md の1行が、依頼のたびに回路を届ける。スキルは要らない
3. 結果が駄目なら `/autopoiesys:run-feedback` に一言。回路が直る

## スキルを追加する / CI

1. `skills/<name>/SKILL.md` を作り、`.claude-plugin/marketplace.json` の `plugins[].skills` にそのパスを追記する
2. `claude plugin validate --strict .` がローカルで通ることを確認してから push する（push・PR で CI が validate と、`skills` に宣言したディレクトリの存在チェックを実行する）
