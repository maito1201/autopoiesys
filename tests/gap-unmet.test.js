'use strict';
// F010: 目的層の基準を一度でも実測すると、不合格でも AVAILABLE に吸い込まれ、
// caveats からも agenda からも消えていた。「測れていない」と「測って不合格」を
// 同じ語で呼ぶと、実測した瞬間に未達が見えなくなる（F005と同型の再発）。
//
// 分類・caveats・agenda の3層すべてを見る。分類だけ直して残り2つが変わらなければ、
// 直したのは見かけだけである。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write } = require('./helpers');
const { gapAnalysis } = require('../core/gap');
const evaluate = require('../core/evaluate');
const { agenda } = require('../core/agenda');

const GOAL = [
  'goal: テスト用',
  'domain: software_engineering',
  'success_criteria:',
  '  - id: sc-pass',
  '    statement: 通っている基準',
  '    evaluator: ev_pass',
  '  - id: sc-fail',
  '    statement: 測った結果おちている基準',
  '    evaluator: ev_fail',
  '  - id: sc-never',
  '    statement: 一度も測っていない基準',
  '    evaluator: ev_never',
  'constraints: []',
  '',
].join('\n');

function evaluatorYaml(id) {
  return [`id: ${id}`, 'applies_to: repo_change', 'tier: T0', 'kind: outcome',
    'method: command', 'argv: [node, noop.js]', 'expect_exit: 0', ''].join('\n');
}

// verdict台帳に直接書く（evaluate経由だと実コマンド実行が要る）。
// 「最新行が現在状態」という規則はlatestVerdictsと共通
function writeVerdicts(osDir, rows) {
  const file = path.join(osDir, 'evaluations', 'log.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function setup() {
  const { osDir } = makeOs();
  write(osDir, 'goal.yaml', GOAL);
  for (const id of ['ev_pass', 'ev_fail', 'ev_never']) write(osDir, `evaluators/${id}.yaml`, evaluatorYaml(id));
  writeVerdicts(osDir, [
    { ts: '2026-08-29T01:00:00Z', task: 'T001', evaluator: 'ev_pass', verdict: 'PASS' },
    { ts: '2026-08-29T01:00:00Z', task: 'T001', evaluator: 'ev_fail', verdict: 'PASS' },
    // 最新行がFAIL。件数だけを見ると「測って問題なし」と区別できない
    { ts: '2026-08-29T02:00:00Z', task: 'T002', evaluator: 'ev_fail', verdict: 'FAIL', reason: 'insufficient_sample' },
  ]);
  return { osDir };
}

function byId(items) {
  const m = {};
  for (const i of items) m[i.id || i.ref] = i;
  return m;
}

test('gap: 最新verdictがFAILの基準はUNMET、PASSはAVAILABLE、未実行はUNVERIFIED', () => {
  const { osDir } = setup();
  const m = byId(gapAnalysis(osDir, { criteriaOnly: true }).required);
  assert.strictEqual(m['success_criteria:sc-fail'].classification, 'UNMET');
  assert.ok(m['success_criteria:sc-fail'].why.includes('insufficient_sample'));
  assert.strictEqual(m['success_criteria:sc-pass'].classification, 'AVAILABLE');
  assert.strictEqual(m['success_criteria:sc-never'].classification, 'UNVERIFIED');
});

test('caveats: 測って不合格の基準が、測れていない基準とは別の文言で出る', () => {
  const { osDir } = setup();
  const t = evaluate.newTask(osDir, '完了したタスク', []);
  evaluate.updateTask(osDir, t.id, { status: 'done' });
  const caveats = evaluate.nextAction(osDir, t.id).caveats || [];
  const unmet = caveats.find((c) => c.includes('sc-fail'));
  const never = caveats.find((c) => c.includes('sc-never'));
  assert.ok(unmet, '測って不合格の基準がcaveatsに出る');
  assert.ok(unmet.includes('測定した結果、現在不合格'));
  assert.ok(never && never.includes('測定できていない'), '未測定は別の文言');
  assert.ok(!caveats.some((c) => c.includes('sc-pass')), '通っている基準は出ない');
});

test('agenda: UNMETは未測定より高いスコアで出て、insufficient_sampleなら「直せ」と言わない', () => {
  const { osDir } = setup();
  const m = byId(agenda(osDir).items);
  const unmet = m['success_criteria:sc-fail'];
  const never = m['success_criteria:sc-never'];
  assert.strictEqual(unmet.kind, 'unmet_criterion');
  assert.ok(unmet.score > never.score, '測って落ちている方が確度が高い');
  // 検出力不足に「手法を直せ」と言うのは誤った指示である
  assert.ok(unmet.action.includes('標本'));
  assert.ok(!unmet.action.includes('原因を調べて直す'));
});

test('agenda: fail_reasonが検出力不足でないUNMETには、原因を調べて直せと言う', () => {
  const { osDir } = setup();
  writeVerdicts(osDir, [
    { ts: '2026-08-29T02:00:00Z', task: 'T002', evaluator: 'ev_fail', verdict: 'FAIL' },
  ]);
  const unmet = byId(agenda(osDir).items)['success_criteria:sc-fail'];
  assert.ok(unmet.action.includes('原因を調べて直す'));
});
