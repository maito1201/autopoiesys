'use strict';
// Token Ledger・Researchセッション・知識コンパイル（設計原則§14）。
// 「推論を資産化する」の出入口: research openで開始、構造化findingsをcompileで資産化、
// closeで産出物を検査する（資産ゼロのDeep Researchは警告）。
const fs = require('node:fs');
const path = require('node:path');
const { readJsonl, appendJsonl, nowIso, nextId, atomicWriteFile } = require('./util');
const { assertStatements } = require('./store');

const TIERS = ['T0', 'T1', 'T2', 'T3'];
const CANDIDATE_KINDS = ['query', 'evaluator', 'rule', 'golden_task', 'procedure', 'detector'];
// kind → .os/ 内の格納ディレクトリ（機械的な複数形化はquery→querysの誤パスを生む）
const KIND_DIRS = {
  query: 'queries',
  evaluator: 'evaluators',
  rule: 'rules',
  golden_task: 'golden_tasks',
  procedure: 'rules',   // procedureはrule群として格納する（MVP）
  detector: 'evaluators', // 安価な検出器はevaluator（T0）として格納する
};

function costsFile(osDir) {
  return path.join(osDir, 'observations', 'costs.jsonl');
}

function researchFile(osDir) {
  return path.join(osDir, 'observations', 'research.jsonl');
}

// 全LLM作業の自己申告記録（Skillの義務）
// トークン値は実行者の手入力であり、測定値と見積りが混ざると optimization の
// コスト判断を誤る。値を入れるなら測定/見積りの別を必ず持たせ、
// 分からないなら入れない（測れないものを台帳に入れない）。
function ledgerAdd(osDir, { purpose, tier, model, tokens_in, tokens_out, task, session, asset_refs, measured = false }) {
  if (!purpose) throw new Error('purpose必須');
  if (!TIERS.includes(tier)) throw new Error(`tierは ${TIERS.join('|')}`);
  const entry = {
    ts: nowIso(),
    purpose,
    tier,
    model: model || '',
  };
  const hasTokens = tokens_in !== undefined || tokens_out !== undefined;
  if (hasTokens) {
    const inN = Number(tokens_in);
    const outN = Number(tokens_out);
    if (!Number.isFinite(inN) || !Number.isFinite(outN) || inN < 0 || outN < 0) {
      throw new Error('tokens_in / tokens_out は0以上の数値を両方指定する（片方だけの記録は集計を歪める）');
    }
    entry.tokens_in = inN;
    entry.tokens_out = outN;
    // 既定は見積り。APIの実測値を持っている場合だけ measured を立てる
    entry.estimated = !measured;
  }
  if (task) entry.task = task;
  if (session) entry.session = session;
  if (asset_refs && asset_refs.length) entry.asset_refs = asset_refs;
  appendJsonl(costsFile(osDir), entry);
  return entry;
}

function loadResearchSessions(osDir) {
  const rows = readJsonl(researchFile(osDir));
  const byId = {};
  for (const r of rows) {
    const cur = byId[r.id] || { id: r.id, state: 'open', assets: [] };
    if (r.event === 'open') Object.assign(cur, { purpose: r.purpose, opened_ts: r.ts });
    if (r.event === 'close') Object.assign(cur, { state: 'closed', assets: r.assets || [], closed_ts: r.ts });
    byId[r.id] = cur;
  }
  return byId;
}

function researchOpen(osDir, purpose) {
  if (!purpose) throw new Error('purpose必須');
  const byId = loadResearchSessions(osDir);
  const id = nextId('R', Object.keys(byId), 3);
  appendJsonl(researchFile(osDir), { ts: nowIso(), id, event: 'open', purpose });
  return { id, purpose };
}

// 資産化の出口検査: 資産ゼロで閉じるDeep Researchは警告（§14）。
// budget（config.yamlのbudgets.research_tokens）超過もここで検査する。
function researchClose(osDir, id, assets, { budget } = {}) {
  const byId = loadResearchSessions(osDir);
  if (!byId[id]) throw new Error(`Researchセッションが存在しない: ${id}`);
  if (byId[id].state === 'closed') throw new Error(`既にclose済み: ${id}`);
  const list = assets || [];
  appendJsonl(researchFile(osDir), { ts: nowIso(), id, event: 'close', assets: list });
  const warnings = [];
  if (list.length === 0) {
    warnings.push(
      `警告: ${id} は資産（rule/query/evaluator/golden_task）を1つも産出せずに終了した。` +
      '高性能LLMの推論をraw reasoningのまま捨てていないか確認せよ（設計原則§14）'
    );
  }
  const spent = readJsonl(costsFile(osDir))
    .filter((c) => c.session === id)
    .reduce((sum, c) => sum + (c.tokens_in || 0) + (c.tokens_out || 0), 0);
  if (budget && spent > budget) {
    warnings.push(`警告: ${id} のtoken消費 ${spent} が予算 budgets.research_tokens=${budget} を超過した`);
  }
  return { id, assets: list, tokens_spent: spent, warning: warnings.length ? warnings.join('\n') : null };
}

// 構造化findings（T3の出力形式）を資産へ変換する。
// findings = { session?, claims: [...Statement断片...], candidates: [{kind, name, note}] }
function compileFindings(osDir, findings) {
  if (!findings || typeof findings !== 'object') throw new Error('findingsがオブジェクトでない');
  const session = findings.session;
  const claims = findings.claims || [];
  const candidates = findings.candidates || [];
  if (claims.length === 0 && candidates.length === 0) {
    throw new Error('findingsが空。T3の出力はclaims/candidatesの構造化形式に限定される（自由散文は資産化できない）');
  }
  const statements = claims.map((c) => ({
    ...c,
    type: c.type || 'claim',
    status: c.status || 'hypothesis',
    provenance: c.provenance || { source: 'compile-findings', method: 'llm', session },
  }));
  const asserted = statements.length
    ? assertStatements(osDir, statements)
    : { added: [], skipped: [], warnings: [] };
  const proposals = [];
  for (const cand of candidates) {
    if (!CANDIDATE_KINDS.includes(cand.kind)) {
      throw new Error(`未知のcandidate kind: ${cand.kind}（対応: ${CANDIDATE_KINDS.join(', ')}）`);
    }
    if (!cand.name || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cand.name)) {
      throw new Error(`candidateにname必須（英数字とハイフン）: ${JSON.stringify(cand)}`);
    }
    const file = path.join(osDir, 'proposals', `${cand.kind}-${cand.name}.md`);
    const body = [
      `# 提案: ${cand.kind} / ${cand.name}`,
      '',
      `- session: ${session || '(なし)'}`,
      `- 起案: compile-findings`,
      '',
      '## 内容',
      cand.note || '(記述なし)',
      '',
      '## 次の手順',
      `対応するBuild Skill（build-query-system / build-evaluation-model 等）でこの提案を`,
      `実際の定義ファイル（.os/${KIND_DIRS[cand.kind]}/）に落とし、`,
      'この提案ファイルを削除する。',
      '',
    ].join('\n');
    atomicWriteFile(file, body);
    proposals.push(file);
  }
  return { statements_added: asserted.added, statements_skipped: asserted.skipped, warnings: asserted.warnings, proposals };
}

module.exports = { ledgerAdd, researchOpen, researchClose, loadResearchSessions, compileFindings, TIERS };
