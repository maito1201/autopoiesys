'use strict';
// F009: 蒸留の処遇に「届いたが適用しなかった」を第一級で持たせる。
// helped/misled の2値では、正しい教訓を適用しなかった場合に選べる語が無く、
// misled を選ぶと正しい教訓が反証で引退し、無申告だと事象が台帳から消える。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeOs, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');
const experience = require('../core/experience');
const taskclass = require('../core/taskclass');
const claimaudit = require('../core/claimaudit');

function setup() {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('L1', 'lesson', '件数は一次記録で確定させる', { when: '報告に件数を書くとき' }),
  ]);
  const t = evaluate.newTask(osDir, '処遇テスト', [], { class: '監査のテスト' });
  evaluate.updateTask(osDir, t.id, { status: 'done' });
  return { osDir, taskId: t.id };
}

test('unapplied: 理由つきで記録され、教訓に極性リンクは張られない', () => {
  const { osDir, taskId } = setup();
  const r = taskclass.recordConsolidation(osDir, taskId, {
    none_learned: 'このタスク固有の学びは無い',
    unapplied: ['L1'],
    unapplied_reason: '適用場面はあったが、測定後の再測定を怠った',
  });
  assert.deepStrictEqual(r.consolidated.unapplied, ['L1']);
  assert.ok(r.consolidated.unapplied_reason.includes('再測定'));
  // 教訓は無傷（supports も counters も増えない）
  const lf = experience.lessonsFor(osDir, { terms: ['一次記録'] });
  const l1 = lf.lessons.find((l) => l.id === 'L1');
  assert.ok(l1);
  assert.strictEqual(l1.helped, 0);
  assert.strictEqual(l1.misled, 0);
});

test('unapplied: 理由なしは拒否・理由だけも拒否（開示の強制）', () => {
  const { osDir, taskId } = setup();
  assert.throws(
    () => taskclass.recordConsolidation(osDir, taskId, { none_learned: 'x', unapplied: ['L1'] }),
    /unapplied_reasonが必須/
  );
  assert.throws(
    () => taskclass.recordConsolidation(osDir, taskId, { none_learned: 'x', unapplied_reason: '理由だけ' }),
    /unapplied_reasonだけがある/
  );
});

test('unapplied: helped/misledとの重複は矛盾した開示として拒否', () => {
  const { osDir, taskId } = setup();
  assert.throws(
    () => taskclass.recordConsolidation(osDir, taskId, {
      none_learned: 'x', helped: ['L1'], unapplied: ['L1'], unapplied_reason: 'r',
    }),
    /helpedとunappliedに同じIDがある/
  );
});

test('unapplied: 監査briefingに理由つきで載る（misledと言わない逃げ道を監査可能にする）', () => {
  const { osDir, taskId } = setup();
  taskclass.recordConsolidation(osDir, taskId, {
    none_learned: 'x', unapplied: ['L1'], unapplied_reason: '適用場面はあったが怠った',
  });
  const r = claimaudit.buildClaimAudit(osDir, taskId);
  const text = fs.readFileSync(r.file, 'utf8');
  assert.ok(text.includes('unapplied（適用しなかったと申告）: L1'));
  assert.ok(text.includes('適用場面はあったが怠った'));
  assert.ok(r.claimed.find((c) => c.lesson === 'L1' && c.role === 'unapplied'));
});

test('coverage: unappliedの申告も監査の分母に入る', () => {
  const { osDir, taskId } = setup();
  taskclass.recordConsolidation(osDir, taskId, {
    none_learned: 'x', unapplied: ['L1'], unapplied_reason: 'r',
  });
  assert.strictEqual(claimaudit.auditCoverage(osDir).claimed, 1);
});
