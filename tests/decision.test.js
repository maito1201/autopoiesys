'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs } = require('./helpers');
const decision = require('../core/decision');
const store = require('../core/store');

const SITUATION = 'ジョブキューの実装方式を選ぶ';
const OPTIONS = ['redis', 'postgres', 'sqs'];

function makeDecision(osDir, over = {}) {
  return decision.newDecision(osDir, 'ジョブキューはRedisで実装する', {
    situation: SITUATION,
    options: OPTIONS,
    chosen: 'redis',
    criteria: ['運用コスト', '既存スタックとの整合'],
    expected_outcome: 'p95のキュー遅延が100ms未満に収まる',
    tags: ['infra'],
    source: 'user',
    ...over,
  });
}

test('決定を書こうとした瞬間に、同じ判断の場の過去が返る（再来が契機）', () => {
  const { osDir } = makeOs();
  const first = makeDecision(osDir);
  assert.match(first.id, /^S\d{4}$/);
  // 初回は突き返す過去が無い
  assert.deepStrictEqual(first.recall.prior, []);
  assert.deepStrictEqual(first.recall.messages, []);

  // 同じ場に戻ってくると、前回の選択が返る。結果が未記録なら「今埋めろ」と言う
  const second = makeDecision(osDir, { body: 'やはりRedisで実装する' });
  assert.strictEqual(second.recall.prior.length, 1);
  assert.strictEqual(second.recall.prior[0].chosen, 'redis');
  assert.deepStrictEqual(second.recall.unreviewed, [first.id]);
  assert.ok(second.recall.messages.some((m) => m.includes('結果が未記録')));
  assert.ok(second.recall.messages.some((m) => m.includes('答え合わせの時')));
  // 判断の場が同じなら fingerprint は一致する
  assert.strictEqual(second.statement.fingerprint, first.statement.fingerprint);
});

test('言い回しが違っても、同じ situation と options なら同じ判断の場として一致する', () => {
  const { osDir } = makeOs();
  const a = makeDecision(osDir);
  const b = decision.newDecision(osDir, '全く違う書き方をした本文', {
    situation: SITUATION,
    options: ['sqs', 'redis', 'postgres'], // 並び順が違っても同じ場
    chosen: 'redis',
    source: 'user',
  });
  assert.strictEqual(b.statement.fingerprint, a.statement.fingerprint);
  assert.strictEqual(b.recall.prior.length, 1);
});

test('situationが無ければ書けない（判断の場を同定できないため）', () => {
  const { osDir } = makeOs();
  assert.throws(() => decision.newDecision(osDir, 'x', { source: 'u' }), /--situation が必要/);
  assert.strictEqual(store.loadEvents(osDir).length, 0);
});

test('outcomeは追記でdecisionをsupersedeしない（derived_fromで元へ張る）', () => {
  const { osDir } = makeOs();
  const { id } = makeDecision(osDir);
  const r = decision.recordOutcome(osDir, id, { result: 'met' });
  assert.strictEqual(r.suggest_feedback, false);

  const snap = store.getSnapshot(osDir);
  assert.strictEqual(snap.statements[id].type, 'decision');
  const out = snap.statements[r.id];
  assert.strictEqual(out.type, 'outcome');
  assert.strictEqual(out.supersedes, undefined);
  assert.deepStrictEqual(out.links, [{ role: 'derived_from', to: id }]);
  assert.strictEqual(out.result, 'met');
  assert.strictEqual(out.decision, id);
  assert.deepStrictEqual(snap.indexes.links_in[id], [{ from: r.id, role: 'derived_from' }]);
  assert.strictEqual(store.loadEvents(osDir).length, 2);
});

test('unmetはFailure起票を促す', () => {
  const { osDir } = makeOs();
  const { id } = makeDecision(osDir);
  const r = decision.recordOutcome(osDir, id, { result: 'unmet', note: 'p95が300msで頭打ち' });
  assert.strictEqual(r.suggest_feedback, true);
  assert.match(r.message, /feedback/);
  assert.match(r.message, /p95のキュー遅延/);
  const all = decision.listDecisions(osDir);
  assert.strictEqual(all[0].reviewed, true);
  assert.strictEqual(all[0].outcome.result, 'unmet');
  assert.deepStrictEqual(decision.listDecisions(osDir, { unreviewed: true }), []);
});

test('検証: bodyなし・chosenがoptions外・不正なresult・存在しないdecision', () => {
  const { osDir } = makeOs();
  assert.throws(() => decision.newDecision(osDir, '', {}), /bodyが必要/);
  assert.throws(
    () => decision.newDecision(osDir, 'x', { situation: 's', options: ['a', 'b'], chosen: 'c' }),
    /options に含まれない/
  );
  assert.throws(() => decision.newDecision(osDir, 'x', { situation: 's', criteria: 'コスト' }), /criteriaは/);
  assert.strictEqual(store.loadEvents(osDir).length, 0);

  const { id } = makeDecision(osDir);
  assert.throws(() => decision.recordOutcome(osDir, id, { result: 'maybe' }), /met\|unmet\|unclear/);
  assert.throws(() => decision.recordOutcome(osDir, 'S9999', { result: 'met' }), /存在しない/);
  const other = store.recordStatement(osDir, { body: 'ただの主張', type: 'claim', source: 'test' });
  assert.throws(
    () => decision.recordOutcome(osDir, other.added[0], { result: 'met' }),
    /type: decisionではない/
  );
});

test('再レビューは最新のoutcomeで判定し、前回分も返す', () => {
  const { osDir } = makeOs();
  const { id } = makeDecision(osDir);
  const first = decision.recordOutcome(osDir, id, { result: 'unclear' });
  const second = decision.recordOutcome(osDir, id, { result: 'unmet', note: '再計測でNG' });
  assert.deepStrictEqual(second.previous_outcome, { id: first.id, result: 'unclear' });
  assert.strictEqual(second.suggest_feedback, true);
  const all = decision.listDecisions(osDir);
  assert.strictEqual(all[0].outcome.id, second.id);
  assert.strictEqual(all[0].outcome.result, 'unmet');
});

test('situationは type: decision 以外には付けられない', () => {
  const { osDir } = makeOs();
  assert.throws(
    () => store.assertStatements(osDir, [{
      type: 'claim', body: 'x', status: 'fact', situation: 'a',
      provenance: { source: 't', method: 'human' },
    }]),
    /situationは type: decision でのみ使える/
  );
});
