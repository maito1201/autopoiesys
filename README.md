# autopoiesys — 判断の瞬間に、判断の材料を届ける

LLM エージェントに高度な仕事を任せられない原因は、知性の不足ではない。判断の瞬間に知識が届かないこと。
エージェントは、自分が何を思い出せていないかを知らない。記録に残っていても、引きに行かなければ届かず、引きに行く事は運用では起きない。
autopoiesys は、その瞬間に材料を押し出すための最小の道具である。押し出すのは材料（目的、既に退けられた筋、前に同じ場面で何が起きたか）であって、規則や手順ではない。止めない、確認させない。
本当に求められている物を理解していないと気づきながら作り続けること（官僚主義）を止めるのは、別 plugin の [anti-bureaucracy](https://github.com/maito1201/anti-bureaucracy)。

## 考え方

- 評価の単位は、モデル単体ではなく、モデルと装置の組。装置と一緒なら正しく振る舞う事を目指す。
- 似た依頼や判断が再び来た瞬間に、前回のやり取りと、それに対する本人の反応を差し込む。暦や期限ではなく、再来が契機になる。
- 覚え書きに書くのは、自分で確かめた事と、それをどう確かめたか。毎回読み込むのは入口の1枚だけにし、小さく保つ。
- 覚え書きと元のやり取りが食い違ったら、元のやり取りが正しい。区切りで照らし合わせて直す。
- 規則・手順・注意書きは積み上げない。溜まった用心は、不要な確認と停止を生む。

## 何があるか

- `hooks/recall.py` — 依頼が来るたびに、全プロジェクトの記録から似た過去の依頼を探し、その時の応答と、続く本人の発話を差し込む。似た物が無ければ何も出さない。LLM は呼ばない（python だけで動く）
- `skills/init-memory/` — 覚え書きの場所を作る。入口の1枚（今の目標・今の計画・覚え書きの場所）と notes/ を置き、CLAUDE.md から入口を指す
- `skills/dream/` — 覚え書きを確かめ直す。元のやり取りとリポジトリに照らして、誤りを直し、古い物を消し、重なりをまとめ、入口を小さく保つ
- `template/MEMORY.md` — 入口の初期形
- `scripts/corrections.py` — Claude Code の実行ログから本人の短い発話を日付つきで出す（python だけで動く）
- `scripts/check.sh` — 入口が小さく保たれているかを見る

スキル・`template/`・`scripts/` は autopoiesys plugin として配布される。スキル内からは `${CLAUDE_PLUGIN_ROOT}/template/` と `${CLAUDE_PLUGIN_ROOT}/scripts/` がそのままを指す。

## インストール（環境で一度）

```bash
claude plugin marketplace add maito1201/anti-bureaucracy
claude plugin marketplace add maito1201/autopoiesys
claude plugin install autopoiesys@autopoiesys
```

autopoiesys は anti-bureaucracy に依存しているので、3行目で両方入る。1行目は依存先の marketplace を Claude Code に教えるためのもの。
Claude Code を起動し直すと、2スキルが `/autopoiesys:init-memory` などのコマンドとして使え、anti-bureaucracy の要求が毎セッション届く。以後どのリポジトリでも同じ。

旧版の autopoiesys plugin を入れていた人は、`claude plugin update` では新しい依存が入らない。1行目のあと `claude plugin install autopoiesys@autopoiesys` を再実行すると anti-bureaucracy が一緒に入る。
Codex CLI では plugin 間の依存が無いので、2つとも入れる（`.codex-plugin/plugin.json` と `.agents/plugins/marketplace.json` を同梱）。anti-bureaucracy の hook は `codex` の `/hooks` で信頼してから効く。スキルは `$autopoiesys:init-memory` のように呼ぶ。

```bash
codex plugin marketplace add maito1201/anti-bureaucracy
codex plugin add anti-bureaucracy@anti-bureaucracy
codex plugin marketplace add maito1201/autopoiesys
codex plugin add autopoiesys@autopoiesys
```

以前 `scripts/install.sh` でスキルを symlink していた人は、plugin 導入前に `~/.claude/skills/{anti-bureaucracy,init-os,run-feedback,run-task}`（旧版のスキル） を削除する。置いたままにするとユーザースキルと plugin スキルの二重に読まれる。

## 使い方の流れ

1. 最初は `/autopoiesys:init-memory`。目標を聞かれ、入口が置かれ、CLAUDE.md に1行入る
2. 以後は CLAUDE.md の1行が、仕事の始めに入口を届ける。スキルは要らない
3. 仕事の区切りや、訂正された後に `/autopoiesys:dream`。覚え書きが元のやり取りに照らして直る

## コミットする前に動作を確かめる

```bash
claude plugin validate --strict .
```

宣言ファイルの検査。

```bash
claude --plugin-dir .
```

このリポジトリの作業中の版を、そのセッションに限って読み込む。インストール済みの同名の plugin ではなく、作業中の版のスキルが使える。

```bash
python hooks/recall.py --try "試したい依頼の文"
```

その依頼で何が差し込まれるかを、セッションを起こさずに表示する。

## スキルを追加する / CI

1. `skills/<name>/SKILL.md` を作り、`.claude-plugin/marketplace.json` の `plugins[].skills` にそのパスを追記する
2. `claude plugin validate --strict .` がローカルで通ることを確認してから push する（push・PR で CI が validate と、`skills` に宣言したディレクトリの存在チェックを実行する）
