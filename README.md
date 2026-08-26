# autopoiesys — Intelligence OS Builder

高価なLLM推論を使い捨てず、ルール・Query・評価器・検出器という再利用可能な資産に変換して
蓄積する「知性のOS」を、目的を一言伝えるだけで自動構築するOSS。
OSは使うほど賢く安くなり、失敗のたびに「なぜOSはこれを防げなかったか」まで遡って自らを作り替える。
完了判定はエージェントではなくOSが下す。

```
LLM = Intelligence generator / Researcher
OS  = Accumulated intelligence + execution environment
```

コンセプト全文は [CONCEPT.md](CONCEPT.md)、設計判断と代替案の検討は
[docs/DESIGN.md](docs/DESIGN.md)、`.os/` の形式契約は [SCHEMA.md](SCHEMA.md)。

## 必要環境

- Node.js >= 20（それ以外の依存ゼロ。`npm install` 不要）
- git（推奨。履歴の観測とOSバージョン管理に使う）
- Claude Code等のAgent Skill対応LLMエージェント（OS Builderの知的動作を担う）

Windows / macOS / Linux で動作する。CLIは常に
`node cli/index.js <cmd> [--flags]` の1形式で、シェル構文（パイプ・リダイレクト）を使わない。

## クイックスタート

```
git clone <このリポジトリ>
cd autopoiesys
node cli/index.js doctor
```

Claude Codeでこのディレクトリを開き:

```
/init-os
```

ヒアリング → `goal.yaml` → ユーザー承認の後、`/discover-domain` → `/build-query-system` →
`/build-evaluation-model` でOSが構築され、`/run-task` で仕事が始まる。

結果に不満があれば、それを一言伝えるだけでよい:

```
node cli/index.js feedback "この結果は駄目だった"
```

`/investigate-failure` が Root Cause →「なぜOSはこれを防げなかったか」→
OS Upgrade提案（新しい検出器 + 回帰テスト）まで自律的に進める。

## アーキテクチャ

```
┌────────────────────────────── OSS Core（このリポジトリ・領域非依存）─┐
│  skills/     OS BuilderのAgent Skill群（知的動作。LLMが実行）        │
│  cli/ core/  決定的コア（Node.js依存ゼロ。LLM呼び出しゼロ）          │
│  SCHEMA.md   .os/ 形式契約（format_versionで版管理）                 │
└──────────────────────────────────────────────────────────────────────┘
                     │ 生成・操作（契約はSCHEMA.mdとCLIのみ）
                     ▼
┌────────────────────────────── ユーザー固有OS（.os/・完全分離）──────┐
│  goal.yaml         Goal Specification（成功基準→評価器に接地）       │
│  world_model/      Statementイベントログ（事実/仮説/不明を区別）     │
│  queries/          宣言的Query定義（max_tokens強制）                 │
│  evaluators/       独立評価器（deterministic / command / llm_judge） │
│  failures/         Failure状態機械（ログ死蔵をlintで禁止）           │
│  golden_tasks/     回帰テスト（検出力テスト付き）                    │
│  observations/     Token Ledger・Query実行記録                       │
└──────────────────────────────────────────────────────────────────────┘
```

設計の柱（詳細は docs/DESIGN.md）:

1. **独立評価** — Agentの「完了しました」はどのコードパスでも使われない。
   決定的評価のFAILはLLM判定で覆せない
2. **Failure状態機械** — 全Failureは root cause と why_undetected（なぜOSは防げなかったか）
   を経て、最低1つの回帰テストと1つの検出器を残すまで完了できない
3. **Token Economics** — 文脈はmax_tokens強制のQuery経由のみ。T3（高性能LLM）の出力は
   構造化findingsに限定され `autopoiesys compile` で資産化。全LLM消費はToken Ledgerで計測
4. **進化** — golden task回帰・検出力テスト・os_versionにより、OS自体が安全に作り替わる

## CLI

```
node cli/index.js help
```

## テスト

```
node --test
```

## ライセンス

MIT
