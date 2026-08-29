'use strict';
// Routing表の接続（A3）。検証する要件: ①config.yamlのrouting表からtierが導出される
// ②escalationシグナルはpurposeより優先してT3へ昇格する ③どのuse_forにも当たらない
// purposeは既定のT2 ④どの経路でも「なぜその tier か」の根拠文字列が返る
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeOs } = require('./helpers');
const { loadConfig } = require('../core/schema');
const { recommendTier } = require('../core/routing');

// init-osが生成する既定のrouting表をそのまま入力にする（表とコードの乖離を検出するため、
// テスト内で表を書き起こさずscaffoldの出力を読む）
function scaffoldedConfig() {
  const { osDir } = makeOs();
  return loadConfig(osDir);
}

test('routing: 既知のpurposeはuse_forに載るtierになる', () => {
  const cfg = scaffoldedConfig();
  const r = recommendTier(cfg, { purpose: 'classification' });
  assert.strictEqual(r.tier, 'T1');
  assert.strictEqual(r.model, 'cheap');
  assert.strictEqual(r.escalated, false);
  assert.match(r.reason, /classification/);
  assert.match(r.reason, /T1/);

  assert.strictEqual(recommendTier(cfg, { purpose: 'planning' }).tier, 'T2');
  assert.strictEqual(recommendTier(cfg, { purpose: 'os_redesign' }).tier, 'T3');
});

test('routing: escalationシグナルはpurposeより優先してT3へ昇格する', () => {
  const cfg = scaffoldedConfig();
  // 単独でならT1になるpurposeでも、不確かな判定が絡めば高位モデルに上げる
  const r = recommendTier(cfg, { purpose: 'classification', signals: ['uncertain_verdict'] });
  assert.strictEqual(r.tier, 'T3');
  assert.strictEqual(r.model, 'high');
  assert.strictEqual(r.escalated, true);
  assert.deepStrictEqual(r.matched_signals, ['uncertain_verdict']);
  // 根拠には「何のシグナルで」「どこから上げたか」が両方入る
  assert.match(r.reason, /uncertain_verdict/);
  assert.match(r.reason, /T1/);
  assert.match(r.reason, /T3/);

  for (const s of ['unknown_fingerprint', 'conflicting_evidence']) {
    assert.strictEqual(recommendTier(cfg, { purpose: 'summary', signals: [s] }).tier, 'T3');
  }
  // 文字列1件でも配列と同じに扱う（CLIの --signal を素通しできる）
  assert.strictEqual(recommendTier(cfg, { purpose: 'summary', signals: 'uncertain_verdict' }).tier, 'T3');
});

test('routing: 未知のpurposeは既定のT2、根拠にその旨が出る', () => {
  const cfg = scaffoldedConfig();
  const r = recommendTier(cfg, { purpose: 'yak_shaving' });
  assert.strictEqual(r.tier, 'T2');
  assert.strictEqual(r.model, 'mid');
  assert.strictEqual(r.escalated, false);
  assert.match(r.reason, /yak_shaving/);
  assert.match(r.reason, /既定/);
  // purpose自体が無くても落ちず、既定を根拠つきで返す
  const none = recommendTier(cfg, {});
  assert.strictEqual(none.tier, 'T2');
  assert.match(none.reason, /purpose 未指定/);
  assert.strictEqual(recommendTier(cfg).tier, 'T2');
});

test('routing: escalation表に無いシグナルは黙って無視せず根拠に残す', () => {
  const cfg = scaffoldedConfig();
  // 綴り違いのシグナルで「昇格したつもり」になる事故を、出力で見えるようにする
  const r = recommendTier(cfg, { purpose: 'classification', signals: ['uncertain_verdicts'] });
  assert.strictEqual(r.tier, 'T1');
  assert.strictEqual(r.escalated, false);
  assert.deepStrictEqual(r.unknown_signals, ['uncertain_verdicts']);
  assert.match(r.reason, /uncertain_verdicts/);
});

test('routing: 表を書き換えれば結果も変わる（コードに焼き付いていない）', () => {
  const cfg = {
    routing: {
      T0: 'deterministic',
      T1: { model: 'cheap', use_for: ['triage'] },
      T2: { model: 'mid', use_for: [] },
      T3: { model: 'high', use_for: ['audit'] },
      escalation: ['budget_exceeded'],
    },
  };
  assert.strictEqual(recommendTier(cfg, { purpose: 'triage' }).tier, 'T1');
  assert.strictEqual(recommendTier(cfg, { purpose: 'classification' }).tier, 'T2'); // 表に無い＝既定
  assert.strictEqual(recommendTier(cfg, { purpose: 'audit' }).tier, 'T3');
  // 既にT3のpurposeにシグナルが乗っても矛盾した根拠を書かない
  const already = recommendTier(cfg, { purpose: 'audit', signals: ['budget_exceeded'] });
  assert.strictEqual(already.tier, 'T3');
  assert.match(already.reason, /既に/);
  // routing表そのものが無いときも例外にせず既定＋根拠を返す
  const noRouting = recommendTier({}, { purpose: 'triage' });
  assert.strictEqual(noRouting.tier, 'T2');
  assert.match(noRouting.reason, /routing 表が無い/);
});

test('routing: 実際の .os/config.yaml でも既定表と同じtierになる', () => {
  const cfg = loadConfig(path.join(__dirname, '..', '.os'));
  assert.strictEqual(recommendTier(cfg, { purpose: 'checklist' }).tier, 'T1');
  assert.strictEqual(recommendTier(cfg, { purpose: 'integration' }).tier, 'T2');
  assert.strictEqual(recommendTier(cfg, { purpose: 'critical_failure' }).tier, 'T3');
  assert.strictEqual(recommendTier(cfg, { purpose: 'integration', signals: ['conflicting_evidence'] }).tier, 'T3');
});
