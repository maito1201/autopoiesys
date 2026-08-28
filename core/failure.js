'use strict';
// Failure台帳と状態機械。「ログとして保存して終わる」(設計原則§26④) と
// 「局所修正で終わる」(§26⑦) を遷移条件で機械的に禁止する。
const fs = require('node:fs');
const path = require('node:path');
const { readJsonl, appendJsonl, nowIso, nextId, fingerprint, atomicWriteFile } = require('./util');

const STATES = ['reported', 'investigated', 'classified', 'upgrade_proposed', 'implemented', 'accepted_risk'];
const TERMINAL = ['implemented', 'accepted_risk'];
const CLASSIFICATIONS = [
  // v1（実装部品指向）: OSのどの部品ファイルが欠けたか
  'missing_knowledge', 'missing_query', 'missing_constraint', 'missing_test',
  'missing_evaluator', 'bad_workflow', 'bad_model',
  // v2（知性構造指向, CONCEPTv2 §9）: どの知性の層が欠けたか
  'incorrect_knowledge',     // 知識は存在するが内容が誤り（missing_knowledgeと区別）
  'missing_relation',        // 両端の知識はあるが関係が未表現だった
  'missing_condition',       // 知識・判断の適用条件が未表現だった
  'missing_decision_model',  // 知識はあるが判断に変換するルールが無かった
  'missing_capability',      // 必要な能力自体が未導出だった
  'wrong_architecture',      // 個別部品でなくOSの知的構造そのものの誤り
];
const LEGAL_TRANSITIONS = {
  reported: ['investigated', 'accepted_risk'],
  investigated: ['classified', 'accepted_risk'],
  classified: ['upgrade_proposed', 'accepted_risk'],
  upgrade_proposed: ['implemented', 'accepted_risk'],
};
const DETECTOR_KINDS = ['evaluator', 'rule', 'query', 'detector'];

function ledgerFile(osDir) {
  return path.join(osDir, 'failures', 'ledger.jsonl');
}

// idごとに状態遷移イベントを畳み込んだ現在ビュー
function loadFailures(osDir) {
  const rows = readJsonl(ledgerFile(osDir));
  const byId = {};
  for (const r of rows) {
    const cur = byId[r.id] || { id: r.id, history: [] };
    cur.history.push(r);
    Object.assign(cur, r, { history: cur.history });
    if (!cur.reported_ts && r.state === 'reported') cur.reported_ts = r.ts;
    byId[r.id] = cur;
  }
  return byId;
}

// ユーザーの「この結果は駄目」一言から起票する。既知fingerprintの照合結果も返す（cheap経路）。
function report(osDir, { symptom, source = 'user_feedback', severity = 'medium', task }) {
  if (!symptom) throw new Error('symptomは必須');
  const byId = loadFailures(osDir);
  const fp = fingerprint(symptom);
  const known = Object.values(byId).filter((f) => f.fingerprint === fp && f.state === 'implemented');
  const id = nextId('F', Object.keys(byId), 3);
  const entry = { id, ts: nowIso(), state: 'reported', symptom, source, severity, fingerprint: fp };
  if (task) entry.task = task;
  appendJsonl(ledgerFile(osDir), entry);
  return {
    entry,
    known_matches: known.map((k) => ({ id: k.id, symptom: k.symptom, assets: k.assets || [] })),
  };
}

function transition(osDir, id, to, fields = {}) {
  const byId = loadFailures(osDir);
  const cur = byId[id];
  if (!cur) throw new Error(`Failureが存在しない: ${id}`);
  const legal = LEGAL_TRANSITIONS[cur.state] || [];
  if (!legal.includes(to)) {
    throw new Error(`不正な遷移: ${cur.state} -> ${to}（許可: ${legal.join(', ') || 'なし（終端状態）'}）`);
  }
  const errors = [];
  if (to === 'investigated') {
    if (!fields.root_cause) errors.push('root_cause必須');
    if (!fields.why_undetected) errors.push('why_undetected必須（なぜOSはこれを防げなかったか）');
  } else if (to === 'classified') {
    if (!CLASSIFICATIONS.includes(fields.classification)) {
      errors.push(`classificationは ${CLASSIFICATIONS.join('|')}`);
    }
    // 診断の参照先（どのstatement/evaluator/relationが問題か）。散文への埋没を防ぐ
    if (fields.refs !== undefined && (!Array.isArray(fields.refs) || fields.refs.some((r) => typeof r !== 'string'))) {
      errors.push('refsは文字列の配列（例: ["S0004", "evaluator:tests_pass"]）');
    }
  } else if (to === 'upgrade_proposed') {
    if (!fields.proposal) errors.push('proposal必須（提案内容またはファイルref）');
  } else if (to === 'implemented') {
    const assets = fields.assets;
    if (!Array.isArray(assets) || assets.length === 0) {
      errors.push('assets必須（このFailureが生んだOS資産の一覧）');
    } else {
      const hasGolden = assets.some((a) => a && a.kind === 'golden_task');
      const hasDetector = assets.some((a) => a && DETECTOR_KINDS.includes(a.kind));
      if (!hasGolden) errors.push('assetsに最低1件の golden_task が必要（§26④）');
      if (!hasDetector) errors.push(`assetsに最低1件の検出系資産（${DETECTOR_KINDS.join('|')}）が必要（§26④）`);
      for (const a of assets) {
        if (!a || !a.kind || !a.ref) errors.push('assetは{kind, ref}が必須');
      }
    }
    if (!fields.regression_ref) errors.push('regression_ref必須（regression実行済みが遷移条件）');
  } else if (to === 'accepted_risk') {
    if (!fields.reason) errors.push('reason必須');
    // リスク受容でも「なぜOSはこれを防げなかったか」だけは省略不可（§26⑦）
    if (!fields.why_undetected && !cur.why_undetected) {
      errors.push('why_undetected必須（リスク受容でも、なぜOSが防げなかったかは記録する）');
    }
  }
  if (errors.length) throw new Error(`遷移 ${id} -> ${to} の必須フィールド不足:\n  ${errors.join('\n  ')}`);
  const entry = { id, ts: nowIso(), state: to, ...fields };
  // 「分類しても検出器は生まれない」を塞ぐ。missing_evaluator と分類した時点で
  // 提案スタブを起票し、Failureに紐づける（適用は upgrade-os の承認制のまま）。
  const stub = scaffoldClassificationProposal(osDir, cur, fields);
  if (stub) entry.proposal_stub = stub;
  appendJsonl(ledgerFile(osDir), entry);
  return entry;
}

// classification に対応する提案スタブを .os/proposals/ に生成する。
// 既存ファイルは上書きしない（人が書き足した提案を巻き戻さない）。
function scaffoldClassificationProposal(osDir, cur, fields) {
  if (fields.classification !== 'missing_evaluator') return null;
  const file = path.join(osDir, 'proposals', `${cur.id}-evaluator.yaml`);
  if (fs.existsSync(file)) return path.relative(osDir, file);
  const evId = `${cur.id.toLowerCase()}_detector`;
  atomicWriteFile(file, [
    `# ${cur.id} の分類 missing_evaluator から自動起票された提案スタブ。`,
    '# 未適用の提案であり、evaluators/ に移すまで評価には使われない。',
    `# 症状: ${String(cur.symptom || '').replace(/\r?\n/g, ' ')}`,
    `# 根本原因: ${String(cur.root_cause || '(未記入)').replace(/\r?\n/g, ' ')}`,
    `# なぜ検出できなかったか: ${String(cur.why_undetected || '(未記入)').replace(/\r?\n/g, ' ')}`,
    '#',
    '# 埋めること: applies_to（この検出器が対象にする成果物の型）、method（deterministic/command なら',
    '# checks/argv、llm_judge なら rubric）、kind（conformance=規定への適合 / outcome=目的の達成）。',
    `id: ${evId}`,
    'applies_to: TODO',
    'tier: T0',
    'kind: conformance',
    'method: deterministic',
    'checks:',
    '  - kind: file_matches',
    '    path: TODO',
    '    pattern: TODO',
    `origin_failure: ${cur.id}`,
  ].join('\n') + '\n');
  return path.relative(osDir, file);
}

// 非終端のまま滞留したFailureを検出する。regressionはこれを不合格条件に含める。
function lint(osDir, { staleAfterDays = 7, now } = {}) {
  const byId = loadFailures(osDir);
  const violations = [];
  const nowMs = now ? Date.parse(now) : Date.now();
  for (const f of Object.values(byId)) {
    if (TERMINAL.includes(f.state)) continue;
    const reportedMs = Date.parse(f.reported_ts || f.ts);
    const ageDays = (nowMs - reportedMs) / 86400000;
    if (ageDays > staleAfterDays) {
      violations.push({
        id: f.id,
        state: f.state,
        age_days: Math.floor(ageDays),
        symptom: f.symptom,
        message: `${f.id}: ${Math.floor(ageDays)}日間 ${f.state} のまま滞留（Failureをログで終わらせない）`,
      });
    }
  }
  return violations;
}

module.exports = { STATES, TERMINAL, CLASSIFICATIONS, loadFailures, report, transition, lint, scaffoldClassificationProposal };
