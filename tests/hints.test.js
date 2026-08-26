'use strict';
// 運用ヒント（そろそろregression / Failure滞留）の回帰テスト
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs, write } = require('./helpers');
const { runRegression, maintenanceHints } = require('../core/regression');
const failure = require('../core/failure');

function daysLater(base, days) {
  return new Date(Date.parse(base) + days * 86400000).toISOString();
}

test('資産も失敗もない初期状態ではヒントを出さない', () => {
  const { osDir } = makeOs();
  assert.deepStrictEqual(maintenanceHints(osDir), []);
});

test('失敗があるのにregression未実行なら実行を推奨する', () => {
  const { osDir } = makeOs();
  failure.report(osDir, { symptom: '何か駄目' });
  const hints = maintenanceHints(osDir);
  assert.ok(hints.some((h) => h.includes('一度も実行されていない')), hints.join('\n'));
});

test('前回regressionからregression_every_days超過で推奨、期間内なら沈黙', () => {
  const { root, osDir } = makeOs();
  const base = '2026-08-27T00:00:00Z';
  runRegression(osDir, { repoRoot: root, now: base }); // 履歴が記録される
  assert.deepStrictEqual(
    maintenanceHints(osDir, { now: daysLater(base, 3) }).filter((h) => h.includes('regression')),
    []
  );
  const late = maintenanceHints(osDir, { now: daysLater(base, 8) });
  assert.ok(late.some((h) => h.includes('8日経過')), late.join('\n'));
});

test('Failure滞留は接近で予告、超過で警告になる', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: '滞留する失敗' });
  const base = entry.ts;
  const approaching = maintenanceHints(osDir, { now: daysLater(base, 5) }); // ceil(7*0.7)=5
  assert.ok(approaching.some((h) => h.includes('未消化')), approaching.join('\n'));
  const stale = maintenanceHints(osDir, { now: daysLater(base, 9) });
  assert.ok(stale.some((h) => h.startsWith('警告:') && h.includes(entry.id)), stale.join('\n'));
});

test('regression実行が履歴に残る', () => {
  const { root, osDir } = makeOs();
  write(osDir, 'golden_tasks/.gitkeep', '');
  const r1 = runRegression(osDir, { repoRoot: root });
  assert.strictEqual(typeof r1.pass, 'boolean');
  const { readJsonl } = require('../core/util');
  const path = require('node:path');
  const log = readJsonl(path.join(osDir, 'observations', 'regression.jsonl'));
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].pass, r1.pass);
});
