'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs } = require('./helpers');
const decision = require('../core/decision');
const store = require('../core/store');
const policy = require('../core/policy');

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

test('選択肢は判断の場の同定に含めない（同じ場で比べる手が増減しても同じ場）', () => {
  const { osDir } = makeOs();
  const a = makeDecision(osDir);
  // 選択肢を1つ減らしても、situationが同じなら同じ場に戻ってきたことになる
  const b = decision.newDecision(osDir, '選択肢を絞ってからもう一度決める', {
    situation: SITUATION,
    options: ['redis', 'postgres'],
    chosen: 'redis',
    source: 'user',
  });
  assert.strictEqual(b.statement.fingerprint, a.statement.fingerprint);
  assert.strictEqual(b.recall.prior.length, 1);
  // 選択肢を一切書かずに引いても同じ場に当たる
  const r = decision.recall(osDir, { situation: SITUATION });
  assert.strictEqual(r.prior.length, 2);
});

test('完全一致しなくても、語が重なる過去の決定が near として返る', () => {
  const { osDir } = makeOs();
  const a = makeDecision(osDir);
  // 別の場（fingerprintは一致しない）だが、語が重なる
  const r = decision.recall(osDir, { situation: 'ジョブキューの監視方式を選ぶ' });
  assert.deepStrictEqual(r.prior, [], '完全一致は空のまま（近傍は prior に混ぜない）');
  assert.strictEqual(r.near.length, 1);
  assert.strictEqual(r.near[0].id, a.id);
  assert.strictEqual(r.near[0].chosen, 'redis');
  assert.strictEqual(r.near[0].latest_result, null);
  assert.ok(r.messages.some((m) => m.includes('語が重なる過去の決定')));
  // 完全一致した場では、その決定は near に重複して出ない
  const same = decision.recall(osDir, { situation: SITUATION });
  assert.strictEqual(same.prior.length, 1);
  assert.deepStrictEqual(same.near, []);
});

test('語が何も重ならない場では near も空（何でも「近い」と言わない）', () => {
  const { osDir } = makeOs();
  makeDecision(osDir);
  const r = decision.recall(osDir, { situation: '請求書の締め日を決める' });
  assert.deepStrictEqual(r.near, []);
  assert.deepStrictEqual(r.messages, []);
});

test('近傍は語の枠だけの重なりでは成立しない（「〜を選ぶ」で全部が近くならない）', () => {
  const { osDir } = makeOs();
  makeDecision(osDir); // situation: ジョブキューの実装方式を選ぶ
  // 話題が無関係でも「を選/選ぶ」の2語は重なる。これを近傍と呼ばない
  const far = decision.recall(osDir, { situation: 'コーヒー豆の焙煎度合いを選ぶ' });
  assert.deepStrictEqual(far.near, []);
  // 話題が重なるものは拾う
  const near = decision.recall(osDir, { situation: 'ジョブキューの監視方式を選ぶ' });
  assert.strictEqual(near.near.length, 1);
});

test('場の鍵は記録済みfingerprintではなくsituationから引き直される（旧方式の記録を統合する）', () => {
  const { osDir } = makeOs();
  // 旧方式（選択肢を鍵に含めた時代）の記録を模す: fingerprint欄が現在の規則と一致しない
  const r = store.assertStatements(osDir, [{
    type: 'decision',
    body: '旧方式で記録された決定',
    status: 'fact',
    situation: SITUATION,
    fingerprint: 'deadbeef', // situationから計算される値とは異なる
    chosen: 'redis',
    provenance: { source: 'test', method: 'deterministic' },
  }]);
  const legacyId = r.added[0];
  // 現在の規則で同じ場を引くと、旧記録も同じ場の過去として返らなければならない。
  // ここが記録済みfingerprintのままだと、同定規則を直しても過去は別の場に取り残される
  const recalled = decision.recall(osDir, { situation: SITUATION });
  assert.deepStrictEqual(recalled.prior.map((d) => d.id), [legacyId]);
  assert.strictEqual(recalled.fingerprint, policy.situationFingerprint(SITUATION));
});

test('旧方式のfingerprintを持つ決定でも、unmetで方針が自動撤回される（読み出しと書き戻しが同じ鍵）', () => {
  const { osDir } = makeOs();
  // 旧方式（選択肢を鍵に含めた時代）の記録を2件。記録済みfingerprintは現在の規則と一致しない
  const legacy = [];
  for (const body of ['1回目の決定', '2回目の決定']) {
    const r = store.assertStatements(osDir, [{
      type: 'decision',
      body,
      status: 'fact',
      situation: SITUATION,
      fingerprint: 'deadbeef',
      chosen: 'redis',
      provenance: { source: 'test', method: 'deterministic' },
    }]);
    legacy.push(r.added[0]);
  }
  // 1件metで方針が確立する（反復2件・met1件・unmet0件）
  decision.recordOutcome(osDir, legacy[0], { result: 'met', source: 'test' });
  const fp = policy.situationFingerprint(SITUATION);
  assert.strictEqual((policy.getPolicy(osDir, fp) || {}).status, 'active');

  // 同じ場でunmetが出たら、方針は裁量ではなく自動で撤回されなければならない。
  // 書き戻しが記録済みfingerprint（deadbeef）を見ていると、ここが素通りする
  const out = decision.recordOutcome(osDir, legacy[1], { result: 'unmet', source: 'test' });
  assert.ok(out.retracted_policy, '旧方式の記録でも方針が撤回されること');
  assert.strictEqual(policy.getPolicy(osDir, fp).status, 'retracted');
  assert.strictEqual(policy.match(osDir, { situation: SITUATION, log: false }).hit, false);
});
