---
name: discover-domain
description: 対象領域そのものを調査し、World Modelの初期Statementを構築する。高性能LLM（T3）の使用が許可される数少ないSkill。出力は構造化findingsに限定される。
---

# discover-domain

goal.yaml のドメインを調査し、World Model を構築する。
**T3（高性能LLM/Deep Research）の使用が許可される。ただし出力形式は構造化findingsに限定
され、自由散文をそのまま保存することは禁止**（設計原則§14: raw reasoningを資産化せず捨てない）。

## 手順

1. Researchセッションを開く:

       node cli/index.js research open --purpose "<調査目的>"

2. **決定的観測（LLMゼロ）を先に実行する**。T3の推論より先に、すでに体系化されて
   外部に存在する知識を全部入れる（ここを飛ばすと、T3が既知の事実を再発見して払い直す）:

       node cli/index.js sources scan     # 未決定の知識源が残っていないか（残っていればinit-os手順5へ戻す）
       node cli/index.js ingest all       # repo構成 + 作業規約(rule_docs) + 自動メモリ(memory_dir)

   `ingest repo` だけでは規約ドキュメントと自動メモリが入らない。**`all` で回すこと**

3. 調査対象は目的によって動的に決める。固定Schemaを押し付けない。
   例（Engineer OS）: repository / architecture / documentation / issues / PR履歴 /
   incident履歴 / coding conventions / 過去の失敗。
   例（経営OS）: business model / KPI / コスト構造 / 過去の意思決定と失敗。

4. 大規模な調査をT3で行う場合は、**必ず `.os/briefings/research-<id>.md` に厳選コンテキストを
   編纂してから**新規サブエージェントに渡す。会話履歴の全量を渡さない。

5. 調査結果を構造化findings JSONにまとめる:

   ```json
   {
     "session": "R001",
     "claims": [
       {"type": "constraint", "body": "...", "status": "fact", "tags": [...]},
       {"type": "hypothesis", "body": "...", "status": "hypothesis", "confidence": 0.6,
        "links": [{"role": "supports", "to": "obs-..."}]},
       {"type": "unknown", "body": "...因果関係は未確立...", "status": "unknown"}
     ],
     "candidates": [
       {"kind": "query", "name": "get_historical_failures", "note": "..."},
       {"kind": "evaluator", "name": "constraint_check", "note": "..."}
     ]
   }
   ```

   規律:
   - **事実（fact）・仮説（hypothesis）・不明（unknown）を必ず区別する**。仮説には
     confidence と、可能なら supports / counters リンクを付ける
   - 反証（counter evidence）を見つけたら捨てずに `counters` リンクで残す
   - 量より粒度: LLMが後で1件ずつ読める独立した主張にする

6. 資産化と検証:

       node cli/index.js compile --file <findings.json>
       node cli/index.js check

   checkの警告「どのQueryからも引けないStatementが n 件」は、**入れた知識が使われない状態**を
   意味する（引けない事実は運用上存在しない）。`node cli/index.js audit reachability` で対象を確認し、
   Queryの絞り込み軸を足す（build-query-system）か、Statementのtag/scopeを直して解消する。
   ここを残すと、資産化したつもりの知識が実行時に届かない

7. セッションを閉じる。**産出した資産（candidates→実ファイル化されたもの）を申告する**:

       node cli/index.js research close R001 --assets <カンマ区切りの資産パス>

   資産ゼロの警告が出たら、調査が資産化されていない。claims/candidatesに変換して出し直す。

8. Token Ledgerに記録する:

       node cli/index.js ledger add --purpose discover-domain --tier T3 --tokens-in <n> --tokens-out <n> --session R001
