#!/usr/bin/env node
'use strict';
// F012の検出器: 完了認定のループが停止するか。
//
// 検査するのは2方向で、どちらも「是正の系列」と「同じ状態への食い違い」の**区別**を見る:
//   ① last_action が RESOLVE_CONFLICT なのに、同じ状態への食い違いが台帳に無い
//      → 是正（FAIL → 成果物の登録 → PASS）を矛盾と読み違えて、直したタスクを永久に
//        完了させない状態。実測: T016はこれで RESOLVE_CONFLICT から出られなかった
//   ② last_action が DONE なのに、同じ状態への食い違いがある
//      → 覆った理由を調べないまま完了にした状態。①を直すときに緩めてはいけない側
//
// 「同じ状態への食い違い」= 最後の成果物登録（artifacts[].ts の最大値）以降に記録された
// llm/human の判定のうち、同じevaluatorがPASSとFAILの両方を出していること。
// deterministic を除くのは、それが判断ではなく再測定だからである（入力の台帳が育って
// 結果が変わるのは矛盾ではない。最新のFAILは next-action の決定的FAILが拾う）。
//
// この検出器は台帳の記録だけで決まる。実行者の申告は読まない。
//
// 使い方: node scripts/check-completion-terminates.js [.osのパス]
const fs = require('node:fs');
const path = require('node:path');

const osDir = path.resolve(process.argv[2] || '.os');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const tasks = {};
for (const r of readJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'))) {
  if (r && r.id) tasks[r.id] = { ...(tasks[r.id] || {}), ...r };
}

const verdictsByTask = {};
for (const v of readJsonl(path.join(osDir, 'evaluations', 'log.jsonl'))) {
  if (!v || !v.task) continue;
  const byEv = (verdictsByTask[v.task] = verdictsByTask[v.task] || {});
  (byEv[v.evaluator] = byEv[v.evaluator] || []).push(v);
}

function lastArtifactTs(task) {
  let last = '';
  for (const a of (task && task.artifacts) || []) {
    const ts = String(a.ts || '');
    if (ts > last) last = ts;
  }
  return last || null;
}

// 同じ状態への食い違い（evaluator名の配列を返す）
function conflicts(task) {
  const sinceTs = lastArtifactTs(task);
  const hit = [];
  for (const [evId, rows] of Object.entries(verdictsByTask[task.id] || {})) {
    const seq = rows
      .filter((r) => (r.provenance === 'llm' || r.provenance === 'human')
        && (!sinceTs || String(r.ts || '') > sinceTs))
      .map((r) => r.verdict);
    if (seq.includes('PASS') && seq.includes('FAIL')) hit.push(`${evId}(${seq.join('→')})`);
  }
  return hit;
}

// 判定者自身が「証拠が矛盾している」と申告した場合も RESOLVE_CONFLICT の正当な根拠になる
function declaredConflict(task) {
  for (const rows of Object.values(verdictsByTask[task.id] || {})) {
    const last = rows[rows.length - 1];
    if (last && last.reason === 'conflicting_evidence') return true;
  }
  return false;
}

const violations = [];
let checked = 0;
for (const task of Object.values(tasks)) {
  const action = task.last_action;
  if (!action) continue;
  checked++;
  const hit = conflicts(task);
  if (action === 'RESOLVE_CONFLICT' && !hit.length && !declaredConflict(task)) {
    violations.push(
      `NG: ${task.id}: last_action=RESOLVE_CONFLICT だが、同じ状態への判定の食い違いが台帳に無い`
      + '（是正の系列を矛盾と読み違えている。next-action を引き直せば正しい行き先に移る）'
    );
  }
  if (action === 'DONE' && hit.length) {
    violations.push(
      `NG: ${task.id}: last_action=DONE だが、同じ状態への判定が食い違っている: ${hit.join(', ')}`
      + '（覆った理由を調べないまま完了になっている）'
    );
  }
}

for (const v of violations) process.stdout.write(v + '\n');
if (!violations.length) {
  process.stdout.write(
    `ok: last_action を持つタスク${checked}件。是正の系列を矛盾と誤認した停止も、`
    + '食い違いを抱えたままの完了も無い\n'
  );
  process.exit(0);
}
process.stdout.write(`\n違反 ${violations.length}件。完了認定のループが停止していない（F012）\n`);
process.exit(1);
