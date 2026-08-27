'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs, statement } = require('./helpers');
const store = require('../core/store');

test('assert→snapshot→冪等スキップ', () => {
  const { osDir } = makeOs();
  const r1 = store.assertStatements(osDir, [
    statement('S0001', 'constraint', 'mainに直接pushしない'),
    statement('S0002', 'hypothesis', 'Feature Aはretentionに効く', {
      status: 'hypothesis',
      confidence: 0.61,
      links: [{ role: 'supports', to: 'S0001' }],
    }),
  ]);
  assert.deepStrictEqual(r1.added, ['S0001', 'S0002']);
  const snap = store.getSnapshot(osDir);
  assert.strictEqual(Object.keys(snap.statements).length, 2);
  assert.deepStrictEqual(snap.indexes.by_type.constraint, ['S0001']);
  assert.deepStrictEqual(snap.indexes.links_in.S0001, [{ from: 'S0002', role: 'supports' }]);
  // 再投入は冪等スキップ
  const r2 = store.assertStatements(osDir, [statement('S0001', 'constraint', 'x')]);
  assert.deepStrictEqual(r2.added, []);
  assert.deepStrictEqual(r2.skipped, ['S0001']);
});

test('検証エラー: 不正type・壊れたリンク・confidence範囲', () => {
  const { osDir } = makeOs();
  assert.throws(() => store.assertStatements(osDir, [statement('S0001', 'nonsense', 'x')]), /不正なtype/);
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0001', 'claim', 'x', { links: [{ role: 'supports', to: 'NOPE' }] })]),
    /link先が存在しない/
  );
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0001', 'claim', 'x', { confidence: 1.5 })]),
    /confidence/
  );
  // エラー時は何も書かれない
  assert.strictEqual(store.loadEvents(osDir).length, 0);
});

test('バッチ内id重複はエラー、id省略は自動採番', () => {
  const { osDir } = makeOs();
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0001', 'claim', 'a'), statement('S0001', 'claim', 'b')]),
    /バッチ内でidが重複/
  );
  const r = store.assertStatements(osDir, [
    { type: 'observation', body: 'auto', status: 'fact', provenance: { source: 't', method: 'deterministic' } },
  ]);
  assert.strictEqual(r.added.length, 1);
  assert.match(r.added[0], /^S\d{4}$/);
});

test('supersedesとretractedはsnapshotの現在状態から除外', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'claim', '旧主張', { status: 'hypothesis' }),
    statement('S0002', 'claim', '新主張', { status: 'hypothesis', supersedes: 'S0001' }),
    statement('S0003', 'claim', '撤回済み', { status: 'retracted' }),
  ]);
  const snap = store.getSnapshot(osDir);
  assert.deepStrictEqual(Object.keys(snap.statements).sort(), ['S0002']);
  assert.strictEqual(snap.meta.event_count, 3);
});

test('未登録predicateは警告（strictでエラー）', () => {
  const { osDir } = makeOs();
  const r = store.assertStatements(osDir, [
    statement('S0001', 'entity', 'A'),
    statement('S0002', 'entity', 'B'),
    statement('S0003', 'relationship', 'AはBに未知の関係', { subject: 'S0001', predicate: 'mystery_rel', object: 'S0002' }),
  ]);
  assert.ok(r.warnings.some((w) => w.includes('mystery_rel')));
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0004', 'relationship', 'x', { predicate: 'another_rel' })], { strict: true }),
    /未登録のpredicate/
  );
});

test('recordStatement: add はデフォルト補完と provenance.task を記録する', () => {
  const { osDir } = makeOs();
  const r = store.recordStatement(osDir, {
    body: '仮予約は30分で失効する',
    type: 'constraint',
    tags: ['booking'],
    source: 'app/domain/model/booking.go:34',
    task: 'T001',
  });
  assert.strictEqual(r.added.length, 1);
  const st = store.loadEvents(osDir).find((e) => e.id === r.added[0]);
  assert.strictEqual(st.status, 'fact');
  assert.strictEqual(st.provenance.method, 'llm');
  assert.strictEqual(st.provenance.task, 'T001');
  assert.deepStrictEqual(st.tags, ['booking']);
});

test('recordStatement: supersede は旧Statementから type/tags を継承し snapshot が畳み込む', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', '仮予約は10分で失効する', { tags: ['booking'] }),
  ]);
  const r = store.recordStatement(osDir, {
    body: '仮予約は30分で失効する',
    supersedes: 'S0001',
    source: 'app/domain/model/booking.go:34',
  });
  const snap = store.getSnapshot(osDir);
  assert.strictEqual(snap.statements.S0001, undefined);
  const st = snap.statements[r.added[0]];
  assert.strictEqual(st.type, 'constraint');
  assert.deepStrictEqual(st.tags, ['booking']);
  assert.strictEqual(st.supersedes, 'S0001');
});

test('recordStatement: 検証（type欠落 / hypothesisにconfidence必須 / supersede先不在）', () => {
  const { osDir } = makeOs();
  assert.throws(() => store.recordStatement(osDir, { body: 'x', source: 's' }), /--typeが必要/);
  assert.throws(
    () => store.recordStatement(osDir, { body: 'x', type: 'claim', status: 'hypothesis', source: 's' }),
    /confidence/
  );
  assert.throws(
    () => store.recordStatement(osDir, { body: 'x', supersedes: 'S9999', source: 's' }),
    /supersedes先が現在状態に存在しない/
  );
  // 置換済みStatementへの再supersedeも拒否される（現在状態に無い）
  store.assertStatements(osDir, [statement('S0001', 'claim', '旧')]);
  store.recordStatement(osDir, { body: '新', supersedes: 'S0001', source: 's' });
  assert.throws(
    () => store.recordStatement(osDir, { body: '再訂正', supersedes: 'S0001', source: 's' }),
    /supersedes先が現在状態に存在しない/
  );
});
