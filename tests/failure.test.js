'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

test('classified(missing_evaluator): evaluator提案スタブを起票しFailureに紐づける', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: '創作値が成果物に載った' });
  failure.transition(osDir, entry.id, 'investigated', {
    root_cause: '値の出典突合が無い',
    why_undetected: '引用IDの実在しか見ていない',
  });
  const e = failure.transition(osDir, entry.id, 'classified', { classification: 'missing_evaluator' });
  assert.strictEqual(e.proposal_stub, path.join('proposals', `${entry.id}-evaluator.yaml`));
  const stub = fs.readFileSync(path.join(osDir, e.proposal_stub), 'utf8');
  assert.ok(stub.includes(`id: ${entry.id.toLowerCase()}_detector`), stub);
  assert.ok(stub.includes(`origin_failure: ${entry.id}`), stub);
  // 調査で言語化させた内容が提案に引き継がれる
  assert.ok(stub.includes('引用IDの実在しか見ていない'), stub);
  // 提案どまりであり、evaluators/ には置かれない（適用は承認制のまま）
  assert.ok(!fs.existsSync(path.join(osDir, 'evaluators', `${entry.id.toLowerCase()}_detector.yaml`)));
});

test('提案の差し替え: supersedes_reasonが無ければ再提案できない', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: '誤った提案を撤回できない' });
  failure.transition(osDir, entry.id, 'investigated', {
    root_cause: '提案の差し替え経路が無い',
    why_undetected: '状態機械に自己遷移が無かった',
  });
  failure.transition(osDir, entry.id, 'classified', { classification: 'missing_constraint' });
  failure.transition(osDir, entry.id, 'upgrade_proposed', { proposal: '最初の提案（誤り）' });
  // 理由なしの再提案は拒否（黙って上書きさせない）
  assert.throws(
    () => failure.transition(osDir, entry.id, 'upgrade_proposed', { proposal: '出し直した提案' }),
    /supersedes_reason/
  );
  // proposalも依然として必須
  assert.throws(
    () => failure.transition(osDir, entry.id, 'upgrade_proposed', { supersedes_reason: '対象を取り違えた' }),
    /proposal必須/
  );
  const again = failure.transition(osDir, entry.id, 'upgrade_proposed', {
    proposal: '出し直した提案',
    supersedes_reason: '最初の提案は対象を取り違えていた',
  });
  assert.strictEqual(again.state, 'upgrade_proposed');
  assert.strictEqual(again.supersedes_reason, '最初の提案は対象を取り違えていた');

  // 台帳は追記専用: 両方の提案が履歴として残り、現在ビューは新しい方を指す
  const cur = failure.loadFailures(osDir)[entry.id];
  const proposals = cur.history.filter((h) => h.state === 'upgrade_proposed');
  assert.strictEqual(proposals.length, 2);
  assert.strictEqual(proposals[0].proposal, '最初の提案（誤り）');
  assert.strictEqual(proposals[1].proposal, '出し直した提案');
  assert.strictEqual(cur.proposal, '出し直した提案');

  // 差し替え後もimplementedへ進める
  const done = failure.transition(osDir, entry.id, 'implemented', {
    assets: [
      { kind: 'golden_task', ref: 'gt-003' },
      { kind: 'rule', ref: 'core/failure.js:supersedes_reason' },
    ],
    regression_ref: 'reg-003',
  });
  assert.strictEqual(done.state, 'implemented');
});

test('提案スタブは既存ファイルを上書きしない', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: '別の症状' });
  const file = path.join(osDir, 'proposals', `${entry.id}-evaluator.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# 人が書いた提案\n', 'utf8');
  failure.transition(osDir, entry.id, 'investigated', { root_cause: 'r', why_undetected: 'w' });
  failure.transition(osDir, entry.id, 'classified', { classification: 'missing_evaluator' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '# 人が書いた提案\n');
});
