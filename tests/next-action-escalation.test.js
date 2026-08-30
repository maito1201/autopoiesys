'use strict';
// next-action の escalation（B3）と検出力不足の写像（E3）。
// どちらも「記録から次の一手を決める」ための分岐であり、自己申告では決まらない。
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs } = require('./helpers');
const evaluate = require('../core/evaluate');
const failure = require('../core/failure');

function verdict(osDir, task, evaluator, v, extra = {}) {
  return evaluate.recordVerdict(osDir, {
    task, evaluator, verdict: v, evidence: ['e'], ...extra,
  });
}

test('escalation: 同じevaluatorのUNCERTAINが2回続くと DEEP_RESEARCH', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '2連続UNCERTAIN', ['a']);
  verdict(osDir, t.id, 'a', 'UNCERTAIN');
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'INVESTIGATE');
  verdict(osDir, t.id, 'a', 'UNCERTAIN');
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'DEEP_RESEARCH');
  assert.ok(r.escalation.signals.includes('uncertain_verdict'));
  // 昇格先のtierは自己申告ではなく config.yaml の routing 表から引く
  assert.strictEqual(r.escalation.tier, 'T3');
});

test('escalation: 同じ状態への判定が食い違ったら RESOLVE_CONFLICT（成果物を変えずに引き直しても解けない）', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '同一状態の食い違い', ['a']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-01-01T00:00:00Z' });
  verdict(osDir, t.id, 'a', 'PASS');
  verdict(osDir, t.id, 'a', 'FAIL');
  // FAILの間はFIXが優先される（昇格でFAILを覆い隠さない）
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'FIX');
  verdict(osDir, t.id, 'a', 'PASS');
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'RESOLVE_CONFLICT');
  assert.ok(r.escalation.signals.includes('conflicting_evidence'));
  assert.ok(r.escalation.evidence.some((e) => e.includes('食い違')));
  // 成果物を変えずにもう一度PASSを積んでも矛盾は消えない
  verdict(osDir, t.id, 'a', 'PASS');
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'RESOLVE_CONFLICT');
});

// F012: run-task 手順6が指示する FAIL → 修正 → PASS を、矛盾と読み違えない。
// 読み違えると、正直に是正したタスクほど完了に到達できなくなる（実測: T016）。
// 成果物の再登録より前の判定は「別の状態への判定」であり、いまの状態への矛盾ではない。
test('escalation: 成果物の再登録より前の判定は食い違いに数えない（是正の系列はDONEに到達する）', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '是正の系列', ['a']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-01-01T00:00:00Z' });
  verdict(osDir, t.id, 'a', 'PASS');
  verdict(osDir, t.id, 'a', 'FAIL');
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'FIX');
  verdict(osDir, t.id, 'a', 'PASS');
  // ここまでは同一状態への食い違い
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'RESOLVE_CONFLICT');
  // 指摘を直して登録し直す（= 以後の判定の対象は別の状態になる。tsは記録済み判定より後）
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '指摘への修正', ts: '2099-01-01T00:00:00Z' });
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'DONE');
  assert.ok(!r.escalation || !r.escalation.signals.includes('conflicting_evidence'));
});

// deterministic は判断ではなく再測定である。入力（台帳）が育って結果が変わるのは矛盾ではない
// （最新のFAILは決定的FAILとしてFIXが拾うので、取りこぼしにはならない）。
test('escalation: deterministicの再測定は食い違いに数えない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '再測定', ['a']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-01-01T00:00:00Z' });
  verdict(osDir, t.id, 'a', 'FAIL', { provenance: 'deterministic' });
  verdict(osDir, t.id, 'a', 'PASS', { provenance: 'deterministic' });
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'DONE');
  assert.ok(!r.escalation || !r.escalation.signals.includes('conflicting_evidence'));
});

test('escalation: 未知fingerprintのFailureが未消化なら INVESTIGATE に escalate が付く', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '未知の失敗', ['a']);
  failure.report(osDir, { symptom: '誰も見たことのない壊れ方をした', task: t.id });
  verdict(osDir, t.id, 'a', 'UNCERTAIN');
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'INVESTIGATE');
  assert.ok(r.escalation.signals.includes('unknown_fingerprint'));
  assert.strictEqual(r.escalation.escalate, true);
});

test('escalation: 全PASSのDONEには昇格をかけない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '昇格しない', ['a']);
  failure.report(osDir, { symptom: '未知の症状', task: t.id });
  verdict(osDir, t.id, 'a', 'PASS');
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'DONE');
  // シグナルの記録は残るが、actionは書き換えない
  assert.ok(r.escalation.signals.includes('unknown_fingerprint'));
});

test('E3: insufficient_sample は FIX ではなく COLLECT_EVIDENCE へ写す', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '検出力不足', ['power']);
  verdict(osDir, t.id, 'power', 'FAIL', { reason: 'insufficient_sample' });
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'COLLECT_EVIDENCE');
  assert.ok(r.why.includes('検出力不足'));
});

test('E3: insufficient_sample は他のFAILを覆い隠さない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '両方FAIL', ['power', 'real']);
  verdict(osDir, t.id, 'power', 'FAIL', { reason: 'insufficient_sample' });
  verdict(osDir, t.id, 'real', 'FAIL');
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'FIX');
  assert.ok(r.why.includes('real'));
});

test('E3: 決定的FAILは insufficient_sample の申告では COLLECT_EVIDENCE にならない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '決定的FAILの優先', ['det']);
  verdict(osDir, t.id, 'det', 'FAIL', { provenance: 'deterministic' });
  verdict(osDir, t.id, 'det2', 'UNCERTAIN', { reason: 'insufficient_sample' });
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'FIX');
});
