'use strict';
// Intelligence Graph（CONCEPTv2 手順5-6）の回帰テスト:
// relationship第一級化・統合辺索引・traverse・gap分析・failure分類拡張
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const { runQuery } = require('../core/query');
const gap = require('../core/gap');
const failure = require('../core/failure');
const evaluate = require('../core/evaluate');

function rel(id, subject, predicate, object, extra = {}) {
  return statement(id, 'relationship', extra.body || `${subject} ${predicate} ${object}`, {
    subject, predicate, object, ...extra,
  });
}

test('relationship検証: s/p/o必須・端点の実在・型付き参照・conditions形式', () => {
  const { osDir } = makeOs();
  write(osDir, 'evaluators/ev_ok.yaml', 'id: ev_ok\napplies_to: x\ntier: T0\nmethod: command\nargv: [node, -v]\n');
  // s/p/o欠落は拒否
  assert.throws(
    () => store.assertStatements(osDir, [statement('R1', 'relationship', 'x', { subject: 'S0001' })]),
    /predicate|object/
  );
  // 実在しない端点は拒否（LLMの捏造束縛を書き込ませない）
  assert.throws(
    () => store.assertStatements(osDir, [rel('R1', 'NOPE', 'requires', 'ALSO_NOPE')]),
    /存在しない/
  );
  // 実在しないasset refも拒否
  assert.throws(
    () => store.assertStatements(osDir, [
      statement('S0001', 'capability', '能力A'),
      rel('R1', 'S0001', 'evaluated_by', 'evaluator:no_such_ev'),
    ]),
    /参照先が実在しない/
  );
  // conditionsは文字列配列
  assert.throws(
    () => store.assertStatements(osDir, [
      statement('S0001', 'capability', '能力A'),
      rel('R1', 'S0001', 'requires', 'S0001', { conditions: 'not-an-array' }),
    ]),
    /conditions/
  );
  // 正常系: 同一バッチ内ID + 実在するasset ref + conditions/exceptions
  const r = store.assertStatements(osDir, [
    statement('S0001', 'capability', '能力A'),
    rel('R1', 'S0001', 'evaluated_by', 'evaluator:ev_ok', {
      status: 'hypothesis', confidence: 0.8,
      conditions: ['初期構築フェーズ'], exceptions: ['緊急時'],
    }),
  ]);
  assert.deepStrictEqual(r.added, ['S0001', 'R1']);
});

test('snapshot: 統合辺索引（relationship+links）とschema_versionによる強制再生成', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'goal', '目的'),
    statement('S0002', 'capability', '能力', { links: [{ role: 'derived_from', to: 'S0001' }] }),
    rel('R1', 'S0001', 'requires', 'S0002', { status: 'hypothesis', confidence: 0.9 }),
  ]);
  const snap = store.getSnapshot(osDir);
  assert.strictEqual(snap.meta.schema_version, store.SNAPSHOT_SCHEMA_VERSION);
  // relationship辺とlinks辺が統合ビューに両方入る
  const outS1 = snap.indexes.edges_out.S0001.map((e) => `${e.kind}->${e.to}`);
  assert.deepStrictEqual(outS1, ['requires->S0002']);
  const outS2 = snap.indexes.edges_out.S0002.map((e) => `${e.kind}->${e.to}`);
  assert.deepStrictEqual(outS2, ['derived_from->S0001']);
  assert.strictEqual(snap.indexes.edges_in.S0002[0].confidence, 0.9);
  // 旧スキーマのsnapshot（checksum一致でもschema_version不一致）は再生成される
  const file = path.join(osDir, 'world_model', 'snapshot.json');
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.meta.schema_version = 1;
  delete tampered.indexes.edges_out;
  fs.writeFileSync(file, JSON.stringify(tampered), 'utf8');
  const snap2 = store.getSnapshot(osDir);
  assert.ok(snap2.indexes.edges_out.S0001, 'schema_version不一致なら再生成されるべき');
});

test('traverse: 多段BFS・kinds絞込・depth・決定的path', () => {
  const { osDir } = makeOs();
  write(osDir, 'evaluators/ev_ok.yaml', 'id: ev_ok\napplies_to: x\ntier: T0\nmethod: command\nargv: [node, -v]\n');
  store.assertStatements(osDir, [
    statement('S0001', 'goal', '目的'),
    statement('S0002', 'capability', '能力B'),
    statement('S0003', 'claim', '無関係な知識'),
    rel('R1', 'S0001', 'requires', 'S0002'),
    rel('R2', 'S0002', 'evaluated_by', 'evaluator:ev_ok'),
    rel('R3', 'S0001', 'causes', 'S0003'), // kinds外 → 辿らない
  ]);
  write(osDir, 'queries/reasoning_context.yaml', [
    'name: reasoning_context',
    'description: goalからの最小推論文脈',
    'params:',
    '  root:',
    '    required: true',
    'pipeline:',
    '  - traverse: { from_param: root, kinds: [requires, evaluated_by], direction: out, depth: 3, limit: 20 }',
    '  - project: [id, type, body, depth, path]',
    'max_tokens: 4000',
  ].join('\n'));
  const r = runQuery(osDir, 'reasoning_context', { root: 'S0001' });
  const ids = r.results.map((x) => x.id);
  assert.deepStrictEqual(ids, ['S0001', 'S0002', 'evaluator:ev_ok']);
  assert.ok(!ids.includes('S0003'), 'kinds外の辺は辿らない');
  const evRow = r.results[2];
  assert.strictEqual(evRow.type, 'ref'); // World Model外の参照はrefノードとして返る
  assert.strictEqual(evRow.depth, 2);
  // path = Reasoning Pathの実体（経由辺の列）
  assert.deepStrictEqual(evRow.path.map((p) => p.kind), ['requires', 'evaluated_by']);
  assert.deepStrictEqual(evRow.path.map((p) => p.via), ['R1', 'R2']);
  // depth=1では届かない
  write(osDir, 'queries/shallow.yaml', [
    'name: shallow',
    'description: 深さ1',
    'params:',
    '  root:',
    '    required: true',
    'pipeline:',
    '  - traverse: { from_param: root, kinds: [requires, evaluated_by], direction: out, depth: 1 }',
  ].join('\n'));
  const s = runQuery(osDir, 'shallow', { root: 'S0001' });
  assert.deepStrictEqual(s.results.map((x) => x.id), ['S0001', 'S0002']);
});

test('gap: 6分類の決定表とgoal.yaml基準の統合', () => {
  const { root, osDir } = makeOs();
  write(osDir, 'evaluators/ev_ok.yaml', 'id: ev_ok\napplies_to: x\ntier: T0\nmethod: command\nargv: [node, -v]\n');
  write(osDir, 'evaluators/ev_never.yaml', 'id: ev_never\napplies_to: x\ntier: T0\nmethod: command\nargv: [node, -v]\n');
  // ev_okにはverdict実績を作る
  evaluate.recordVerdict(osDir, { task: 'T001', evaluator: 'ev_ok', verdict: 'PASS', evidence: ['e'], provenance: 'deterministic' });
  // goal.yaml: 1基準はev_okに接地(AVAILABLE)、1制約はunbound(MISSING)
  write(osDir, 'goal.yaml', [
    'goal: テスト目的',
    'domain: test',
    'objectives:',
    '  - t',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: 基準1',
    '    evaluator: ev_ok',
    'constraints:',
    '  - id: c-001',
    '    statement: 制約1',
    '    severity: hard',
    '    evaluator: unbound',
  ].join('\n'));
  store.assertStatements(osDir, [
    statement('G1', 'goal', '目的'),
    statement('CAP-M', 'capability', '束縛なし能力'),                                  // → MISSING
    statement('CAP-A', 'capability', '検証済み能力'),                                  // → AVAILABLE
    statement('CAP-U', 'capability', '未実行能力'),                                    // → UNVERIFIED
    statement('K-UNC', 'claim', '低確信の知識', { status: 'hypothesis', confidence: 0.4, provenance: { source: 't', method: 'human' } }), // → UNCERTAIN
    statement('K-UNV', 'claim', 'llm由来・証拠ゼロの知識', { provenance: { source: 't', method: 'llm' } }), // → UNVERIFIED
    statement('K-CON', 'claim', '矛盾を抱えた知識'),                                   // → CONFLICTING
    statement('X1', 'observation', '反対側'),
    rel('R1', 'G1', 'requires', 'CAP-M'),
    rel('R2', 'G1', 'requires', 'CAP-A'),
    rel('R3', 'G1', 'requires', 'CAP-U'),
    rel('R4', 'G1', 'requires', 'K-UNC'),
    rel('R5', 'G1', 'requires', 'K-UNV'),
    rel('R6', 'G1', 'requires', 'K-CON'),
    rel('R7', 'CAP-A', 'evaluated_by', 'evaluator:ev_ok'),
    rel('R8', 'CAP-U', 'evaluated_by', 'evaluator:ev_never'),
    rel('R9', 'K-CON', 'contradicts', 'X1'),
    // 仮説のままのcapabilityでも、検証実績ある束縛があれば可用（statusはUNCERTAINの根拠にしない）
    statement('CAP-H', 'capability', '仮説だが検証済み束縛あり', { status: 'hypothesis', confidence: 0.8 }),
    rel('R10', 'G1', 'requires', 'CAP-H'),
    rel('R11', 'CAP-H', 'evaluated_by', 'evaluator:ev_ok'),
  ]);
  const a = gap.gapAnalysis(osDir, {});
  assert.strictEqual(a.goal, 'G1');
  const byId = {};
  for (const r of a.required) byId[r.id] = r.classification;
  assert.strictEqual(byId['CAP-M'], 'MISSING', JSON.stringify(a.required, null, 1));
  assert.strictEqual(byId['CAP-A'], 'AVAILABLE');
  assert.strictEqual(byId['CAP-U'], 'UNVERIFIED');
  assert.strictEqual(byId['K-UNC'], 'UNCERTAIN');
  assert.strictEqual(byId['K-UNV'], 'UNVERIFIED');
  assert.strictEqual(byId['K-CON'], 'CONFLICTING');
  assert.strictEqual(byId['CAP-H'], 'AVAILABLE');
  // goal.yaml基準も統合される
  assert.strictEqual(byId['success_criteria:sc-001'], 'AVAILABLE');
  assert.strictEqual(byId['constraints:c-001'], 'MISSING');
  assert.ok(a.summary.MISSING >= 2);
  assert.ok(a.next_actions.MISSING);

  // --assert: MISSINGがUnknownとして冪等起票される
  const r1 = gap.assertMissingAsUnknowns(osDir, a);
  assert.ok(r1.added.length >= 1);
  const r2 = gap.assertMissingAsUnknowns(osDir, gap.gapAnalysis(osDir, {}));
  assert.strictEqual(r2.added.length, 0); // 二重起票しない
  assert.ok(r2.skipped.length >= 1);
});

test('gap: criteria-onlyモードはgoalノード不在でも動く', () => {
  const { osDir } = makeOs();
  write(osDir, 'goal.yaml', [
    'goal: g',
    'domain: d',
    'objectives:',
    '  - o',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: s',
    '    evaluator: unbound',
  ].join('\n'));
  assert.throws(() => gap.gapAnalysis(osDir, {}), /goalノードが無い/);
  const a = gap.gapAnalysis(osDir, { criteriaOnly: true });
  assert.strictEqual(a.required[0].classification, 'MISSING');
});

test('failure: 知性構造指向の分類とrefsが受理される', () => {
  const { osDir } = makeOs();
  const { entry } = failure.report(osDir, { symptom: '関係が未表現で判断を誤った' });
  failure.transition(osDir, entry.id, 'investigated', { root_cause: 'x', why_undetected: 'y' });
  assert.throws(
    () => failure.transition(osDir, entry.id, 'classified', { classification: 'missing_relation', refs: 'S0004' }),
    /refsは文字列の配列/
  );
  const r = failure.transition(osDir, entry.id, 'classified', {
    classification: 'missing_relation',
    refs: ['S0004', 'evaluator:tests_pass'],
  });
  assert.strictEqual(r.classification, 'missing_relation');
  assert.deepStrictEqual(r.refs, ['S0004', 'evaluator:tests_pass']);
});
