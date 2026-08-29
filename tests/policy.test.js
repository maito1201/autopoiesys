'use strict';
// 方針層（直感）の3層: 再来検出 → コンパイル → 反証による自動撤回。
// すべて決定的で、LLM呼び出しを含まない。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs } = require('./helpers');
const decision = require('../core/decision');
const policy = require('../core/policy');
const metrics = require('../core/metrics');

const SIT = 'キャッシュ層を入れるかを選ぶ';
const OPTS = ['入れる', '入れない'];

function decide(osDir, body, chosen, over = {}) {
  return decision.newDecision(osDir, body, {
    situation: SIT, options: OPTS, chosen, criteria: ['運用コスト'], source: 'test', ...over,
  });
}

// 反復と結果が揃うまで畳み込まない → 揃った瞬間に方針になる、を1本で通す
function buildPolicy(osDir) {
  const a = decide(osDir, '今回はキャッシュを入れない', '入れない');
  decision.recordOutcome(osDir, a.id, { result: 'met' });
  const b = decide(osDir, '今回もキャッシュを入れない', '入れない');
  return { a, b };
}

test('コンパイル条件を満たすまで方針にならない', () => {
  const { osDir } = makeOs();
  const a = decide(osDir, '入れない', '入れない');
  // 反復1件・結果なし → まだ畳み込まない
  let r = policy.compile(osDir);
  assert.strictEqual(r.compiled.length, 0);
  assert.match(r.skipped[0].why, /met として確認された決定がまだ無い/);

  decision.recordOutcome(osDir, a.id, { result: 'met' });
  r = policy.compile(osDir);
  assert.strictEqual(r.compiled.length, 0);
  assert.match(r.skipped[0].why, /反復が 1 件/);
});

test('反復と結果が揃うと方針へ畳み込まれ、以後は推論なしで発火する', () => {
  const { osDir } = makeOs();
  const { b } = buildPolicy(osDir);
  // 2件目の決定を書いた時点で自動コンパイルされる
  assert.ok(b.compiled_policy, '決定の記録時に畳み込まれること');
  assert.strictEqual(b.compiled_policy.choose, '入れない');
  assert.deepStrictEqual(b.compiled_policy.because, ['運用コスト']);

  const file = path.join(osDir, 'rules', `policy-${b.statement.fingerprint}.yaml`);
  assert.ok(fs.existsSync(file), 'rules/ に方針ファイルが書かれること');

  // 発火。situationとoptionsだけで引ける（World Model全体を読まない）
  const hit = policy.match(osDir, { situation: SIT, options: OPTS });
  assert.strictEqual(hit.hit, true);
  assert.strictEqual(hit.policy.choose, '入れない');

  // 発火はトークン消費ゼロとして台帳に載る
  const log = fs.readFileSync(path.join(osDir, 'observations', 'context_log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const fired = log.filter((r) => r.kind === 'policy_hit');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].tokens_est, 0);
});

test('方針に反する選択は禁じないが、黙って通さない', () => {
  const { osDir } = makeOs();
  buildPolicy(osDir);
  const c = decide(osDir, '今回はキャッシュを入れる', '入れる');
  assert.ok(c.contradicts_policy);
  assert.strictEqual(c.contradicts_policy.policy_choose, '入れない');
  assert.strictEqual(c.contradicts_policy.chosen, '入れる');
  // 記録自体は通っている（違反ではない）
  assert.match(c.id, /^S\d{4}$/);
});

test('unmetが1件出ると方針は自動で撤回される（裁量ではない）', () => {
  const { osDir } = makeOs();
  const { b } = buildPolicy(osDir);
  const fp = b.statement.fingerprint;
  assert.strictEqual(policy.getPolicy(osDir, fp).status, 'active');

  const r = decision.recordOutcome(osDir, b.id, { result: 'unmet', note: '実際には遅くなった' });
  assert.ok(r.retracted_policy);
  assert.strictEqual(r.retracted_policy.status, 'retracted');
  assert.strictEqual(r.retracted_policy.retracted_by, r.id);
  assert.match(r.retracted_policy.retracted_reason, /unmet/);
  // 撤回後は発火しない
  assert.strictEqual(policy.match(osDir, { situation: SIT, options: OPTS }).hit, false);
});

test('撤回された選択は同じ内容で復活しない', () => {
  const { osDir } = makeOs();
  const { b } = buildPolicy(osDir);
  decision.recordOutcome(osDir, b.id, { result: 'unmet' });
  // 同じ選択の反復をさらに積んでも、一度反証された方針は戻らない
  const c = decide(osDir, 'それでも入れない', '入れない');
  decision.recordOutcome(osDir, c.id, { result: 'met' });
  const r = policy.compile(osDir);
  assert.strictEqual(r.compiled.length, 0);
  assert.match(r.skipped[0].why, /unmet がある|一度反証されて撤回されている/);
});

test('失格は場ではなく選択に課す（外れた選択の隣で、別の選択は畳み込める）', () => {
  const { osDir } = makeOs();
  const bad = decide(osDir, '入れる', '入れる');
  decision.recordOutcome(osDir, bad.id, { result: 'unmet' });
  // 「入れる」が外れても「入れない」は反復と結果が揃えば方針になる
  const a = decide(osDir, '入れない', '入れない');
  decision.recordOutcome(osDir, a.id, { result: 'met' });
  const b = decide(osDir, 'また入れない', '入れない');
  assert.ok(b.compiled_policy);
  assert.strictEqual(b.compiled_policy.choose, '入れない');
});

test('方針に反する選択も met になったら、場の切り方が粗いとして凍結する', () => {
  const { osDir } = makeOs();
  const { b } = buildPolicy(osDir);
  const c = decide(osDir, '今回は入れる', '入れる');
  const r = decision.recordOutcome(osDir, c.id, { result: 'met' });
  assert.ok(r.retracted_policy, '対立するmetでも方針は撤回される');
  assert.match(r.retracted_policy.retracted_reason, /切り方が粗い/);
  assert.strictEqual(r.retracted_policy.recompile, 'blocked');

  // 凍結後は、どれだけ反復を積んでも同じ場では畳み込まない
  const d = decide(osDir, 'さらに入れる', '入れる');
  decision.recordOutcome(osDir, d.id, { result: 'met' });
  const comp = policy.compile(osDir, { fingerprint: b.statement.fingerprint });
  assert.strictEqual(comp.compiled.length, 0);
  assert.match(comp.skipped[0].why, /凍結/);
});

test('metricsは発火数ではなく、方針経由と熟慮の結末を分けて出す', () => {
  const { osDir } = makeOs();
  const { b } = buildPolicy(osDir);
  // 方針の確立後に、その場で下した決定の結末が「方針経由」に入る
  const c = decide(osDir, 'また入れない', '入れない');
  decision.recordOutcome(osDir, c.id, { result: 'unmet' });

  const m = metrics.computeMetrics(osDir);
  assert.strictEqual(m.policy.compiled, 1);
  assert.strictEqual(m.policy.retracted, 1);
  assert.strictEqual(m.policy.active, 0);
  // 元になった決定は熟慮側、方針確立後の決定は方針側に数える
  assert.strictEqual(m.policy.outcomes.under_policy.unmet, 1);
  assert.strictEqual(m.policy.outcomes.deliberate.met, 1);
  assert.ok(b.compiled_policy);
});

test('Reasoning Contextに、タスクの語と重なる方針が載る', () => {
  const { osDir } = makeOs();
  buildPolicy(osDir);
  const ctx = require('../core/context').buildReasoningContext(osDir, {
    task: { id: 'T001', objective: 'キャッシュ層を入れるかを選ぶ場面の設計', artifacts: [] },
  });
  const text = ctx.lines.join('\n');
  assert.match(text, /確立済みの方針/);
  assert.match(text, /入れない/);
  assert.match(text, /推論を経ていない/);
});
