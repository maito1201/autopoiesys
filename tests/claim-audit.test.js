'use strict';
// 申告の独立監査（S0035）。helped/misled は申告者=実行者のまま台帳に載るので、
// 台帳の機械記録だけを別文脈の判定者に渡す経路を検証する。
// 検査するのは経路であって判定の中身ではない。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeOs, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');
const experience = require('../core/experience');
const taskclass = require('../core/taskclass');
const claimaudit = require('../core/claimaudit');

// 教訓2件・タスク1件・申告（helped: L1）まで作る。CLIと同じ順序で
// recordConsolidation → experience.feedback を呼ぶ
function setup() {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('L1', 'lesson', '評価の前に成果物を全部登録する', { when: 'evaluateの直前' }),
    statement('L2', 'lesson', '検出器は作った直後に本体へ走らせる', { when: '検出器の実装直後' }),
  ]);
  const t = evaluate.newTask(osDir, '監査対象のタスク', [], { class: '監査のテスト' });
  evaluate.updateTask(osDir, t.id, { status: 'done' });
  taskclass.recordConsolidation(osDir, t.id, { lessons: ['L2'], helped: ['L1'] });
  experience.feedback(osDir, { helped: ['L1'], task: t.id, source: 'task-consolidate' });
  return { osDir, taskId: t.id };
}

test('監査briefingは台帳の機械記録と申告だけを載せ、成果物の中身は載せない', () => {
  const { osDir, taskId } = setup();
  evaluate.updateTask(osDir, taskId, {
    artifacts: [{ path: '.os/tasks/report.md', note: '完了報告', ts: '2026-08-29T01:00:00Z' }],
  });
  const r = claimaudit.buildClaimAudit(osDir, taskId);
  const text = fs.readFileSync(r.file, 'utf8');
  // 申告そのもの（判定対象）は入る
  assert.ok(text.includes('helped（効いたと申告）: L1'));
  assert.ok(text.includes('評価の前に成果物を全部登録する'));
  // 機械記録は入る（登録時刻つき）
  assert.ok(text.includes('.os/tasks/report.md'));
  assert.ok(text.includes('2026-08-29T01:00:00Z'));
  // 判定者への指示: 記録に無いものは contradicted ではない
  assert.ok(text.includes('insufficient と判定せよ'));
  // 独立性の限界が本文に明記されている（同じモデルの別文脈にすぎない）
  assert.ok(text.includes('記録の外に出た独立性ではない'));
  assert.deepStrictEqual(r.claimed.map((c) => c.lesson), ['L1']);
});

test('届いていない教訓を効いたと申告した場合、配信記録が「なし」と明示される', () => {
  const { osDir, taskId } = setup();
  const text = fs.readFileSync(claimaudit.buildClaimAudit(osDir, taskId).file, 'utf8');
  assert.ok(text.includes('配信記録: なし'));
});

// F009: 罰するのは申告であって教訓ではない。実行者の虚偽申告のせいで
// 正しい教訓が反証で引退した実例（S0061）から、contradictedは申告の極性辺を
// 撤回するだけで、教訓に新しい反証を張らない
test('contradicted: 申告由来の支持辺が撤回されるが、教訓に反証は張られない', () => {
  const { osDir, taskId } = setup();
  const before = experience.lessonsFor(osDir, { terms: ['成果物'] });
  assert.ok(before.lessons.find((l) => l.id === 'L1' && l.helped === 1));

  const r = claimaudit.recordClaimAudit(osDir, {
    task: taskId, lesson: 'L1', result: 'contradicted', note: 'artifactの登録が評価より後',
  });
  assert.strictEqual(r.retracted.length, 1, '申告由来の支持辺が1本撤回される');
  assert.deepStrictEqual(r.added, [], '教訓への新しい反証は張らない');

  // 偽の支持は消えるが、教訓は想起に残る（外れたのは申告であって教訓ではない）
  const after = experience.lessonsFor(osDir, { terms: ['成果物'] });
  const l1 = after.lessons.find((l) => l.id === 'L1');
  assert.ok(l1, '教訓は想起に残る');
  assert.strictEqual(l1.helped, 0, '偽の支持は実績から消える');
  assert.strictEqual(after.excluded.find((e) => e.id === 'L1'), undefined, '除外されない');

  const ev = store.getSnapshot(osDir).statements[r.retracted[0]];
  assert.strictEqual(ev, undefined, '撤回されたevidenceは現在状態から消える');
  assert.strictEqual(claimaudit.claimAudits(osDir, taskId)[0].result, 'contradicted', '虚偽申告の事実は監査台帳に残る');
});

// misled側の虚偽申告も対称に扱う: 偽の反証（counters）が撤回され、教訓が想起に復帰する
test('contradicted: misledの虚偽申告では偽の反証が撤回される', () => {
  const ctx = makeOsWithMisled();
  const before = experience.lessonsFor(ctx.osDir, { terms: ['成果物'] });
  assert.ok(before.excluded.find((e) => e.id === 'L1'), '偽のmisledで想起から外れている');
  const r = claimaudit.recordClaimAudit(ctx.osDir, {
    task: ctx.taskId, lesson: 'L1', result: 'contradicted', note: 'misled申告に対応する記録が無い',
  });
  assert.strictEqual(r.retracted.length, 1);
  const after = experience.lessonsFor(ctx.osDir, { terms: ['成果物'] });
  assert.ok(after.lessons.find((l) => l.id === 'L1'), '偽の反証が消えて想起に復帰する');
});

function makeOsWithMisled() {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('L1', 'lesson', '評価の前に成果物を全部登録する', { when: 'evaluateの直前' }),
  ]);
  const t = evaluate.newTask(osDir, 'misled申告のタスク', [], { class: '監査のテスト' });
  evaluate.updateTask(osDir, t.id, { status: 'done' });
  taskclass.recordConsolidation(osDir, t.id, { none_learned: '学びなし', misled: ['L1'] });
  experience.feedback(osDir, { misled: ['L1'], task: t.id, source: 'task-consolidate' });
  return { osDir, taskId: t.id };
}

test('supported: 台帳の極性は動かさず、監査の事実だけを記録する', () => {
  const { osDir, taskId } = setup();
  const r = claimaudit.recordClaimAudit(osDir, { task: taskId, lesson: 'L1', result: 'supported' });
  assert.deepStrictEqual(r.retracted, []);
  assert.deepStrictEqual(r.added, []);
  // 支持を二重に数えない（申告1本のまま）
  const after = experience.lessonsFor(osDir, { terms: ['成果物'] });
  assert.strictEqual(after.lessons.find((l) => l.id === 'L1').helped, 1);
  assert.strictEqual(claimaudit.claimAudits(osDir, taskId)[0].result, 'supported');
});

test('insufficient も記録される（記録に無いことは食い違いではない）', () => {
  const { osDir, taskId } = setup();
  const r = claimaudit.recordClaimAudit(osDir, { task: taskId, lesson: 'L1', result: 'insufficient' });
  assert.deepStrictEqual(r.retracted, []);
  assert.strictEqual(claimaudit.claimAudits(osDir, taskId)[0].result, 'insufficient');
});

test('不正なresult・存在しない教訓・lesson以外は拒否する', () => {
  const { osDir, taskId } = setup();
  assert.throws(() => claimaudit.recordClaimAudit(osDir, { task: taskId, lesson: 'L1', result: 'ok' }), /result/);
  assert.throws(() => claimaudit.recordClaimAudit(osDir, { task: taskId, lesson: 'L9', result: 'supported' }), /存在しない/);
  store.assertStatements(osDir, [statement('C1', 'constraint', '制約')]);
  assert.throws(() => claimaudit.recordClaimAudit(osDir, { task: taskId, lesson: 'C1', result: 'supported' }), /lessonではない/);
});

test('被覆は申告を分母に数える（監査済み件数だけを出さない）', () => {
  const { osDir, taskId } = setup();
  assert.deepStrictEqual(claimaudit.auditCoverage(osDir), {
    claimed: 1, audited: 0, by_result: { supported: 0, contradicted: 0, insufficient: 0 },
  });
  claimaudit.recordClaimAudit(osDir, { task: taskId, lesson: 'L1', result: 'contradicted' });
  assert.deepStrictEqual(claimaudit.auditCoverage(osDir), {
    claimed: 1, audited: 1, by_result: { supported: 0, contradicted: 1, insufficient: 0 },
  });
});
