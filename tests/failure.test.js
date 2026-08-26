'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs } = require('./helpers');
const failure = require('../core/failure');

test('状態機械: 正常系の全遷移とimplementedの資産強制', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: 'timeout時のretryで二重処理', severity: 'high' });
  assert.strictEqual(entry.state, 'reported');
  assert.ok(entry.fingerprint);

  // 必須フィールドなしの遷移は拒否
  assert.throws(() => failure.transition(osDir, entry.id, 'investigated', {}), /why_undetected/);
  failure.transition(osDir, entry.id, 'investigated', {
    root_cause: '冪等性キーの欠如',
    why_undetected: '二重処理を検出するevaluatorが存在しなかった',
  });
  // 遷移順序の強制
  assert.throws(() => failure.transition(osDir, entry.id, 'implemented', {}), /不正な遷移/);
  assert.throws(
    () => failure.transition(osDir, entry.id, 'classified', { classification: 'oops' }),
    /classification/
  );
  failure.transition(osDir, entry.id, 'classified', { classification: 'missing_evaluator' });
  failure.transition(osDir, entry.id, 'upgrade_proposed', { proposal: '新evaluator+golden task追加' });
  // golden_taskなしのimplementedは拒否（§26④）
  assert.throws(
    () => failure.transition(osDir, entry.id, 'implemented', {
      assets: [{ kind: 'evaluator', ref: 'evaluators/dup_check.yaml' }],
      regression_ref: 'reg-001',
    }),
    /golden_task/
  );
  // 検出系資産なしも拒否
  assert.throws(
    () => failure.transition(osDir, entry.id, 'implemented', {
      assets: [{ kind: 'golden_task', ref: 'golden_tasks/gt-001.yaml' }],
      regression_ref: 'reg-001',
    }),
    /検出系資産/
  );
  const done = failure.transition(osDir, entry.id, 'implemented', {
    assets: [
      { kind: 'golden_task', ref: 'golden_tasks/gt-001.yaml' },
      { kind: 'evaluator', ref: 'evaluators/dup_check.yaml' },
    ],
    regression_ref: 'reg-001',
  });
  assert.strictEqual(done.state, 'implemented');
});

test('fingerprint照合: 同一症状の再報告は既知パターンとして返る（cheap経路）', () => {
  const { osDir } = makeOs();
  const first = failure.report(osDir, { symptom: 'デプロイ後にキャッシュが壊れる' });
  failure.transition(osDir, first.entry.id, 'investigated', { root_cause: 'x', why_undetected: 'y' });
  failure.transition(osDir, first.entry.id, 'classified', { classification: 'missing_test' });
  failure.transition(osDir, first.entry.id, 'upgrade_proposed', { proposal: 'p' });
  failure.transition(osDir, first.entry.id, 'implemented', {
    assets: [
      { kind: 'golden_task', ref: 'gt-002' },
      { kind: 'detector', ref: 'd-001' },
    ],
    regression_ref: 'reg-002',
  });
  const second = failure.report(osDir, { symptom: 'デプロイ後に  キャッシュが壊れる' }); // 空白揺れは正規化
  assert.strictEqual(second.known_matches.length, 1);
  assert.strictEqual(second.known_matches[0].id, first.entry.id);
});

test('failure lint: 非終端の滞留を検出', () => {
  const { osDir } = makeOs();
  failure.report(osDir, { symptom: '放置される失敗' });
  const clean = failure.lint(osDir, { staleAfterDays: 7 });
  assert.strictEqual(clean.length, 0); // 起票直後は違反でない
  const future = new Date(Date.now() + 10 * 86400000).toISOString();
  const stale = failure.lint(osDir, { staleAfterDays: 7, now: future });
  assert.strictEqual(stale.length, 1);
  assert.ok(stale[0].message.includes('滞留'));
});

test('accepted_riskはreasonとwhy_undetectedが必須', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: '軽微な表示崩れ', severity: 'low' });
  assert.throws(() => failure.transition(osDir, entry.id, 'accepted_risk', {}), /reason/);
  assert.throws(
    () => failure.transition(osDir, entry.id, 'accepted_risk', { reason: '影響軽微' }),
    /why_undetected/
  );
  const r = failure.transition(osDir, entry.id, 'accepted_risk', {
    reason: '影響軽微・工数対効果で見送り',
    why_undetected: '表示崩れを検出するevaluatorが未整備',
  });
  assert.strictEqual(r.state, 'accepted_risk');
});

test('investigated済みならaccepted_riskでwhy_undetectedを再要求しない', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: '調査後に受容する失敗' });
  failure.transition(osDir, entry.id, 'investigated', { root_cause: 'x', why_undetected: 'y' });
  const r = failure.transition(osDir, entry.id, 'accepted_risk', { reason: '対策コスト過大' });
  assert.strictEqual(r.state, 'accepted_risk');
});
