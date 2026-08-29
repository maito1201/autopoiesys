'use strict';
// Unknownを第一級にする（CONCEPTv2 §13）: 「分からない」が何の判断を塞いでいるか（blocks）と
// どれだけ効くか（importance）を、bodyの散文ではなく構造として持てることを確かめる。
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs, statement } = require('./helpers');
const store = require('../core/store');

test('unknown: blocks/importance付きが受理され、現在状態に保持される', () => {
  const { osDir } = makeOs();
  const r = store.assertStatements(osDir, [
    statement('S0001', 'unknown', 'このKPI変化の原因は何か?', {
      status: 'unknown',
      blocks: ['decision_123', 'evaluator:tests_pass'],
      importance: 0.91,
    }),
  ]);
  assert.deepStrictEqual(r.added, ['S0001']);
  const snap = store.getSnapshot(osDir);
  assert.deepStrictEqual(snap.statements.S0001.blocks, ['decision_123', 'evaluator:tests_pass']);
  assert.strictEqual(snap.statements.S0001.importance, 0.91);
});

test('unknown: blocks/importanceは任意（無くても受理される）', () => {
  const { osDir } = makeOs();
  const r = store.assertStatements(osDir, [
    statement('S0001', 'unknown', '出典が特定できない', { status: 'unknown' }),
  ]);
  assert.deepStrictEqual(r.added, ['S0001']);
});

test('unknown: importanceが数値以外・範囲外なら拒否', () => {
  const { osDir } = makeOs();
  for (const bad of ['0.9', null, Number.NaN, 1.5, -0.1]) {
    assert.throws(
      () => store.assertStatements(osDir, [
        statement('S0001', 'unknown', 'q', { status: 'unknown', importance: bad }),
      ]),
      /importanceは0..1の数値/,
      `importance=${String(bad)} は拒否されるべき`
    );
  }
  assert.strictEqual(store.loadEvents(osDir).length, 0);
});

test('unknown: blocksが文字列配列でなければ拒否', () => {
  const { osDir } = makeOs();
  for (const bad of ['decision_123', [123], ['']]) {
    assert.throws(
      () => store.assertStatements(osDir, [
        statement('S0001', 'unknown', 'q', { status: 'unknown', blocks: bad }),
      ]),
      /blocksは文字列の配列/
    );
  }
  assert.strictEqual(store.loadEvents(osDir).length, 0);
});

test('unknown以外のtypeにblocks/importanceは付けられない', () => {
  const { osDir } = makeOs();
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0001', 'claim', 'x', { blocks: ['D1'] })]),
    /blocksは type: unknown でのみ使える/
  );
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0001', 'claim', 'x', { importance: 0.5 })]),
    /importanceは type: unknown でのみ使える/
  );
});

test('blocksに書かれたIDの実在は検証しない（別空間のIDが入りうる）', () => {
  const { osDir } = makeOs();
  const r = store.assertStatements(osDir, [
    statement('S0001', 'unknown', '基準の解釈が定まらない', {
      status: 'unknown',
      blocks: ['criteria_not_yet_created', 'S9999'],
      importance: 0.4,
    }),
  ]);
  assert.deepStrictEqual(r.added, ['S0001']);
  // lintでもエラーにならない（linksと違い、blocksは実在強制の対象外）
  const { errors } = store.lintWorldModel(osDir);
  assert.deepStrictEqual(errors, []);
});

test('recordStatement経由でもblocks/importanceを渡せる', () => {
  const { osDir } = makeOs();
  const r = store.recordStatement(osDir, {
    type: 'unknown',
    body: 'この閾値の根拠は何か?',
    status: 'unknown',
    source: 'test',
    method: 'human',
    blocks: ['decision_042'],
    importance: 0.7,
  });
  const snap = store.getSnapshot(osDir);
  const st = snap.statements[r.added[0]];
  assert.deepStrictEqual(st.blocks, ['decision_042']);
  assert.strictEqual(st.importance, 0.7);
});
