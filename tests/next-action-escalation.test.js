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

test('escalation: 同じevaluatorの判定が往復したら RESOLVE_CONFLICT', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '判定の往復', ['a']);
  verdict(osDir, t.id, 'a', 'PASS');
  verdict(osDir, t.id, 'a', 'FAIL');
  // FAILの間はFIXが優先される（昇格でFAILを覆い隠さない）
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'FIX');
  verdict(osDir, t.id, 'a', 'PASS');
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'RESOLVE_CONFLICT');
  assert.ok(r.escalation.signals.includes('conflicting_evidence'));
  assert.ok(r.escalation.evidence.some((e) => e.includes('往復')));
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
