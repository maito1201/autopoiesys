'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs } = require('./helpers');
const decision = require('../core/decision');
const store = require('../core/store');

const BEFORE = '2026-09-01T00:00:00Z';
const AFTER = '2026-10-15T00:00:00Z';

function makeDecision(osDir) {
  return decision.newDecision(osDir, 'ジョブキューはRedisで実装する', {
    options: ['redis', 'postgres', 'sqs'],
    chosen: 'redis',
    criteria: ['運用コスト', '既存スタックとの整合'],
    expected_outcome: 'p95のキュー遅延が100ms未満に収まる',
    review_after: '2026-09-30',
    tags: ['infra'],
    source: 'user',
  });
}

test('new→期限経過→due列挙→outcome記録→dueから消える・unmetでfeedback誘導', () => {
  const { osDir } = makeOs();
  const { id } = makeDecision(osDir);
  assert.match(id, /^S\d{4}$/);

  // 期限前はdueに出ない
  assert.deepStrictEqual(decision.listDecisions(osDir, { due: true, now: BEFORE }), []);

  // 期限経過で未レビューとして出る
  const due = decision.listDecisions(osDir, { due: true, now: AFTER });
  assert.deepStrictEqual(due.map((d) => d.id), [id]);
  assert.strictEqual(due[0].chosen, 'redis');
  assert.deepStrictEqual(due[0].options, ['redis', 'postgres', 'sqs']);
  assert.strictEqual(due[0].reviewed, false);

  const r = decision.recordOutcome(osDir, id, { result: 'unmet', note: 'p95が300msで頭打ち' });
  assert.strictEqual(r.suggest_feedback, true);
  assert.match(r.message, /feedback/);
  assert.match(r.message, /p95のキュー遅延/);

  // レビュー済みなので再度dueには出ない
  assert.deepStrictEqual(decision.listDecisions(osDir, { due: true, now: AFTER }), []);
  const all = decision.listDecisions(osDir, { now: AFTER });
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].reviewed, true);
  assert.strictEqual(all[0].outcome.result, 'unmet');
  assert.strictEqual(all[0].outcome.note, 'p95が300msで頭打ち');
});

test('outcomeは追記でdecisionをsupersedeしない（derived_fromで元へ張る）', () => {
  const { osDir } = makeOs();
  const { id } = makeDecision(osDir);
  const r = decision.recordOutcome(osDir, id, { result: 'met' });
  assert.strictEqual(r.suggest_feedback, false);

  const snap = store.getSnapshot(osDir);
  // 元のdecisionは現在状態に残ったまま
  assert.strictEqual(snap.statements[id].type, 'decision');
  const out = snap.statements[r.id];
  assert.strictEqual(out.type, 'outcome');
  assert.strictEqual(out.supersedes, undefined);
  assert.deepStrictEqual(out.links, [{ role: 'derived_from', to: id }]);
  assert.strictEqual(out.result, 'met');
  assert.strictEqual(out.decision, id);
  assert.deepStrictEqual(snap.indexes.links_in[id], [{ from: r.id, role: 'derived_from' }]);
  // 追記専用: イベントは2件とも残る
  assert.strictEqual(store.loadEvents(osDir).length, 2);
});

test('review_afterがイベント指定なら時間では期限切れにしない', () => {
  const { osDir } = makeOs();
  decision.newDecision(osDir, 'キャッシュ層を入れるかは負荷試験後に見直す', {
    chosen: '入れない',
    review_after: '負荷試験の完了時',
    source: 'user',
  });
  assert.deepStrictEqual(decision.listDecisions(osDir, { due: true, now: AFTER }), []);
  const all = decision.listDecisions(osDir, { now: AFTER });
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].overdue, false);
});

test('reviewSummary: 期限切れ件数と運用ヒント', () => {
  const { osDir } = makeOs();
  const { id } = makeDecision(osDir);
  assert.strictEqual(decision.reviewSummary(osDir, { now: BEFORE }).due, 0);
  assert.deepStrictEqual(decision.reviewSummary(osDir, { now: BEFORE }).hints, []);

  const s = decision.reviewSummary(osDir, { now: AFTER });
  assert.strictEqual(s.due, 1);
  assert.strictEqual(s.unreviewed_overdue[0].id, id);
  assert.strictEqual(s.unreviewed_overdue[0].review_after, '2026-09-30');
  assert.strictEqual(s.hints.length, 1);
  assert.match(s.hints[0], /レビュー期限切れのdecisionが1件/);

  decision.recordOutcome(osDir, id, { result: 'unclear', note: '判定に足る計測が無い' });
  assert.strictEqual(decision.reviewSummary(osDir, { now: AFTER }).due, 0);
});

test('検証: bodyなし・chosenがoptions外・不正なresult・存在しないdecision', () => {
  const { osDir } = makeOs();
  assert.throws(() => decision.newDecision(osDir, '', {}), /bodyが必要/);
  assert.throws(
    () => decision.newDecision(osDir, 'x', { options: ['a', 'b'], chosen: 'c' }),
    /options に含まれない/
  );
  assert.throws(() => decision.newDecision(osDir, 'x', { criteria: 'コスト' }), /criteriaは/);
  // 検証で落ちた分は1件も書かれていない
  assert.strictEqual(store.loadEvents(osDir).length, 0);

  const { id } = makeDecision(osDir);
  assert.throws(() => decision.recordOutcome(osDir, id, { result: 'maybe' }), /met\|unmet\|unclear/);
  assert.throws(() => decision.recordOutcome(osDir, 'S9999', { result: 'met' }), /存在しない/);
  // decision以外のStatementにはoutcomeを張れない
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
  const all = decision.listDecisions(osDir, { now: AFTER });
  assert.strictEqual(all[0].outcome.id, second.id);
  assert.strictEqual(all[0].outcome.result, 'unmet');
});
