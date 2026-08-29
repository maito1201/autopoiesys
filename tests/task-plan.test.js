'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeOs, write } = require('./helpers');
const { newTask, getTask, updateTask } = require('../core/evaluate');
const { registerPlan, verifyPlans, plansSection } = require('../core/plan');

function setup() {
  const { root, osDir } = makeOs();
  const task = newTask(osDir, '検証手順の事前固定を確かめる', []);
  return { root, osDir, taskId: task.id };
}

test('registerPlan: ハッシュと登録件数を返し、plans[]に追記される', () => {
  const { root, osDir, taskId } = setup();
  write(root, 'PLAN.md', '1. 対照を置く\n2. 分布を見る\n');
  const r = registerPlan(osDir, taskId, 'PLAN.md');
  assert.strictEqual(r.path, 'PLAN.md');
  assert.strictEqual(r.index, 1);
  assert.strictEqual(r.path_index, 1);
  assert.strictEqual(
    r.hash,
    crypto.createHash('sha256').update('1. 対照を置く\n2. 分布を見る\n', 'utf8').digest('hex')
  );
  const t = getTask(osDir, taskId);
  assert.strictEqual(t.plans.length, 1);
  assert.strictEqual(t.plans[0].hash, r.hash);
  assert.ok(t.plans[0].ts);
});

test('verifyPlans: 変更が無ければ changed:false / ok:true', () => {
  const { root, osDir, taskId } = setup();
  write(root, 'PLAN.md', '手順A\n');
  registerPlan(osDir, taskId, 'PLAN.md');
  const res = verifyPlans(osDir, taskId);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.plans.length, 1);
  assert.strictEqual(res.plans[0].changed, false);
  assert.strictEqual(res.plans[0].current_hash, res.plans[0].registered_hash);
  assert.deepStrictEqual(res.plans[0].warnings, []);
});

test('verifyPlans: 登録後にファイルを書き換えると changed:true で警告が出る', () => {
  const { root, osDir, taskId } = setup();
  write(root, 'PLAN.md', '手順A\n');
  registerPlan(osDir, taskId, 'PLAN.md');
  write(root, 'PLAN.md', '手順A\n手順B（結果を見てから追加）\n');
  const res = verifyPlans(osDir, taskId);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.plans[0].changed, true);
  assert.notStrictEqual(res.plans[0].current_hash, res.plans[0].registered_hash);
  assert.ok(res.plans[0].warnings.length > 0);
  const text = res.plans[0].warnings.join('\n');
  assert.match(text, /一致しない/);
  // 変更を違反と断じない書き方であること
  assert.match(text, /違反ではない/);
});

test('verifyPlans: 改行コードとBOMの差だけでは変更扱いにしない', () => {
  const { root, osDir, taskId } = setup();
  write(root, 'PLAN.md', '手順A\n手順B\n');
  registerPlan(osDir, taskId, 'PLAN.md');
  write(root, 'PLAN.md', '﻿手順A\r\n手順B\r\n');
  const res = verifyPlans(osDir, taskId);
  assert.strictEqual(res.plans[0].changed, false);
  assert.strictEqual(res.ok, true);
});

test('registerPlan: 同じパスを2回登録すると履歴が2件残る（上書きしない）', () => {
  const { root, osDir, taskId } = setup();
  write(root, 'PLAN.md', '手順v1\n');
  const first = registerPlan(osDir, taskId, 'PLAN.md');
  write(root, 'PLAN.md', '手順v2\n');
  const second = registerPlan(osDir, taskId, 'PLAN.md');
  assert.strictEqual(second.index, 2);
  assert.strictEqual(second.path_index, 2);
  const t = getTask(osDir, taskId);
  assert.strictEqual(t.plans.length, 2);
  assert.strictEqual(t.plans[0].hash, first.hash);
  assert.strictEqual(t.plans[1].hash, second.hash);
  assert.notStrictEqual(first.hash, second.hash);
  // 照合は最新登録が基準。履歴の件数も見えること
  const res = verifyPlans(osDir, taskId);
  assert.strictEqual(res.plans.length, 1);
  assert.strictEqual(res.plans[0].registrations, 2);
  assert.strictEqual(res.plans[0].registered_hash, second.hash);
  assert.strictEqual(res.plans[0].changed, false);
});

test('verifyPlans: artifactに登録時刻が無ければ「判定不能」と明示する', () => {
  const { root, osDir, taskId } = setup();
  write(root, 'PLAN.md', '手順A\n');
  registerPlan(osDir, taskId, 'PLAN.md');
  updateTask(osDir, taskId, { artifacts: [{ path: 'RESULT.md', note: '' }] });
  write(root, 'PLAN.md', '手順A2\n');
  const res = verifyPlans(osDir, taskId);
  const all = [...res.warnings, ...res.plans[0].warnings].join('\n');
  assert.match(all, /判定不能/);
  assert.doesNotMatch(all, /mtime[^は]/); // mtimeを根拠にした判定を返さない
});

test('verifyPlans: artifact登録より後の再登録は前後関係として警告に出る', () => {
  const { root, osDir, taskId } = setup();
  updateTask(osDir, taskId, {
    artifacts: [{ path: 'RESULT.md', note: '', ts: '2020-01-01T00:00:00Z' }],
  });
  write(root, 'PLAN.md', '手順A\n');
  registerPlan(osDir, taskId, 'PLAN.md');
  const res = verifyPlans(osDir, taskId);
  assert.strictEqual(res.plans[0].changed, false); // 内容は登録どおり
  assert.match(res.plans[0].warnings.join('\n'), /より後にこのPLANが再登録/);
});

test('verifyPlans: PLANファイルが消えていたら changed:null（変更なしと言わない）', () => {
  const { root, osDir, taskId } = setup();
  const p = write(root, 'PLAN.md', '手順A\n');
  registerPlan(osDir, taskId, 'PLAN.md');
  require('node:fs').unlinkSync(p);
  const res = verifyPlans(osDir, taskId);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.plans[0].changed, null);
  assert.match(res.plans[0].warnings.join('\n'), /判定不能/);
});

test('plansSection: 登録が無ければ「事前固定された手順は無い」と返す', () => {
  const { osDir, taskId } = setup();
  const lines = plansSection(osDir, taskId);
  assert.ok(Array.isArray(lines));
  assert.match(lines.join('\n'), /事前固定された手順は無い/);
});

test('plansSection: 登録済みなら照合結果と「変更＝違反ではない」注記を含む', () => {
  const { root, osDir, taskId } = setup();
  write(root, 'PLAN.md', '手順A\n');
  registerPlan(osDir, taskId, 'PLAN.md');
  const unchanged = plansSection(osDir, taskId).join('\n');
  assert.match(unchanged, /PLAN\.md: 登録時から変更なし/);
  assert.match(unchanged, /違反ではない/);
  write(root, 'PLAN.md', '手順A改\n');
  const changed = plansSection(osDir, taskId).join('\n');
  assert.match(changed, /PLAN\.md: 登録後に変更あり/);
});

test('registerPlan: 存在しないファイルは登録できない', () => {
  const { osDir, taskId } = setup();
  assert.throws(() => registerPlan(osDir, taskId, 'NOPE.md'), /存在しない/);
});
