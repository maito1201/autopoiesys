'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const { runQuery, auditReachability } = require('../core/query');
const { readJsonl } = require('../core/util');
const path = require('node:path');

function seed(osDir) {
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', '制約A', { tags: ['repo'] }),
    statement('S0002', 'constraint', '制約B', { status: 'hypothesis', confidence: 0.9 }),
    statement('S0003', 'claim', '主張C', { status: 'hypothesis', confidence: 0.5 }),
    statement('S0004', 'evidence', '証拠D', { links: [{ role: 'counters', to: 'S0002' }] }),
  ]);
}

test('select/where/sort/project/limitとリンクexpand', () => {
  const { osDir } = makeOs();
  seed(osDir);
  write(osDir, 'queries/get_constraints.yaml', [
    'name: get_constraints',
    'description: 制約一覧',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - expand: { roles: [counters], direction: in, limit: 3 }',
    '  - sort: { by: confidence, order: desc }',
    '  - project: [id, body, confidence, linked]',
    '  - limit: 10',
    'max_tokens: 2000',
  ].join('\n'));
  const r = runQuery(osDir, 'get_constraints', {});
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.results[0].id, 'S0002'); // confidence降順、欠損は末尾
  assert.strictEqual(r.results[0].linked[0].id, 'S0004'); // 反証リンクが添付される
  assert.strictEqual(r.results[1].id, 'S0001');
  assert.strictEqual(r.truncated, false);
});

test('where_paramはパラメータ指定時のみ適用', () => {
  const { osDir } = makeOs();
  seed(osDir);
  write(osDir, 'queries/by_tag.yaml', [
    'name: by_tag',
    'description: タグ絞込',
    'params:',
    '  tag:',
    '    required: false',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - where_param: { field: tags, contains: tag }',
    '  - project: [id]',
  ].join('\n'));
  assert.strictEqual(runQuery(osDir, 'by_tag', {}).count, 2);
  assert.strictEqual(runQuery(osDir, 'by_tag', { tag: 'repo' }).count, 1);
});

test('where_paramのカンマ区切りはOR条件（複数タグ絞り込み）', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', '請求の制約', { tags: ['billing'] }),
    statement('S0002', 'constraint', 'テストの制約', { tags: ['test'] }),
    statement('S0003', 'constraint', '移行の制約', { tags: ['migration'] }),
  ]);
  write(osDir, 'queries/by_tag.yaml', [
    'name: by_tag',
    'description: タグ絞込',
    'params:',
    '  tag:',
    '    required: false',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - where_param: { field: tags, contains: tag }',
    '  - project: [id]',
  ].join('\n'));
  assert.strictEqual(runQuery(osDir, 'by_tag', { tag: 'billing' }).count, 1);
  const r = runQuery(osDir, 'by_tag', { tag: 'billing,test' });
  assert.strictEqual(r.count, 2);
  assert.deepStrictEqual(r.results.map((x) => x.id), ['S0001', 'S0002']);
});

test('max_tokens強制: 切詰めとnext_offset、実行ログ記録', () => {
  const { osDir } = makeOs();
  const many = [];
  for (let i = 1; i <= 50; i++) {
    many.push(statement(`S${String(i).padStart(4, '0')}`, 'observation', `観測データ${i} `.repeat(20)));
  }
  store.assertStatements(osDir, many);
  write(osDir, 'queries/all_obs.yaml', [
    'name: all_obs',
    'description: 全観測',
    'pipeline:',
    '  - select: { type: observation }',
    'max_tokens: 500',
  ].join('\n'));
  const r = runQuery(osDir, 'all_obs', {});
  assert.strictEqual(r.truncated, true);
  assert.ok(r.count < 50);
  assert.strictEqual(r.next_offset, r.count);
  // 続きはoffsetで取れる
  const r2 = runQuery(osDir, 'all_obs', {}, { offset: r.next_offset });
  assert.ok(r2.count > 0);
  const log = readJsonl(path.join(osDir, 'observations', 'query_log.jsonl'));
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].truncated, true);
});

test('必須パラメータと未知Queryはエラー', () => {
  const { osDir } = makeOs();
  write(osDir, 'queries/need_param.yaml', [
    'name: need_param',
    'description: x',
    'params:',
    '  key:',
    '    required: true',
    'pipeline:',
    '  - select: { type: claim }',
  ].join('\n'));
  assert.throws(() => runQuery(osDir, 'need_param', {}), /必須パラメータ/);
  assert.throws(() => runQuery(osDir, 'no_such_query', {}), /存在しない/);
});

// ---- 到達性監査 ----------------------------------------------------------------------
// 検証する要件: ①どのQueryからも引けないStatementを検出する ②必須paramの候補値をWorld Modelの
// 実在値から導き、param必須Queryも監査できる ③limitで最後尾が落ちるだけの事実も到達不能として
// 検出する ④idをprojectしないQueryは監査不能として申告する ⑤監査はquery_logを汚さない

function writeQuery(osDir, name, lines) {
  write(osDir, `queries/${name}.yaml`, [`name: ${name}`, 'description: x', ...lines].join('\n'));
}

test('到達性監査: どのQueryからも引けないStatementを検出する', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', '引ける制約', { tags: ['billing'] }),
    statement('S0002', 'claim', '孤児タグの主張', { tags: ['orphan-topic'] }),
  ]);
  writeQuery(osDir, 'only_constraints', [
    'pipeline:',
    '  - select: { type: constraint }',
    '  - project: [id, body]',
  ]);
  const r = auditReachability(osDir);
  assert.deepStrictEqual(r.unreachable, ['S0002']);
  assert.strictEqual(r.violations, 1);
});

test('到達性監査: task_class付きlessonは想起（digest）経路で到達可能とみなす', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    // どのQueryにも掛からないが、類型の再来時にdigestが必ず配信する
    statement('S0001', 'lesson', 'worktreeは--reposで明示する', {
      when: 'worktreeで作業するとき', task_class: 'abc12345',
    }),
    // task_classの無いlessonはQuery経路でしか届かない — 検出力を落とさない
    statement('S0002', 'lesson', '類型に紐付いていない教訓', { when: 'いつか' }),
  ]);
  writeQuery(osDir, 'only_constraints', [
    'pipeline:',
    '  - select: { type: constraint }',
    '  - project: [id, body]',
  ]);
  const r = auditReachability(osDir);
  assert.deepStrictEqual(r.unreachable, ['S0002']);
  assert.strictEqual(r.reached_via_digest, 1);
});

test('到達性監査: 必須paramの候補値をWorld Modelの実在値から導く', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', 'api固有の作法', { scope: ['api'] }),
    statement('S0002', 'constraint', 'web固有の作法', { scope: ['web'] }),
  ]);
  writeQuery(osDir, 'playbook', [
    'params:',
    '  scope:',
    '    required: true',
    'pipeline:',
    '  - where_param: { field: scope, contains: scope }',
    '  - project: [id, body]',
  ]);
  // scope=api / scope=web の両方が試されるため、両方が到達可能になる
  assert.deepStrictEqual(auditReachability(osDir).unreachable, []);
});

test('到達性監査: limitで最後尾が落ちる事実は到達不能として検出する', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', '1件目'),
    statement('S0002', 'constraint', '2件目'),
  ]);
  writeQuery(osDir, 'capped', [
    'pipeline:',
    '  - select: { type: constraint }',
    '  - sort: { by: id, order: asc }',
    '  - project: [id, body]',
    '  - limit: 1',
  ]);
  const r = auditReachability(osDir);
  assert.deepStrictEqual(r.unreachable, ['S0002']);
  assert.strictEqual(r.truncating.length, 1);
  assert.strictEqual(r.truncating[0].total, 2);
});

test('到達性監査: idをprojectしないQueryは監査不能として申告する', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [statement('S0001', 'constraint', '制約')]);
  writeQuery(osDir, 'no_id', [
    'pipeline:',
    '  - select: { type: constraint }',
    '  - project: [body]',
  ]);
  const r = auditReachability(osDir);
  assert.match(r.defects.join(), /projectにidが無く/);
  assert.strictEqual(r.violations, 2); // 監査不能1件 + 到達不能1件
});

test('到達性監査: query_logを汚さない', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [statement('S0001', 'constraint', '制約')]);
  writeQuery(osDir, 'all', ['pipeline:', '  - select: { type: constraint }', '  - project: [id, body]']);
  auditReachability(osDir);
  assert.deepStrictEqual(readJsonl(path.join(osDir, 'observations', 'query_log.jsonl')), []);
});

test('到達性監査: max_tokensの切り詰めはページングで追えるので到達不能にしない', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', 'あ'.repeat(400)),
    statement('S0002', 'constraint', 'い'.repeat(400)),
  ]);
  writeQuery(osDir, 'tight_budget', [
    'pipeline:',
    '  - select: { type: constraint }',
    '  - sort: { by: id, order: asc }',
    '  - project: [id, body]',
    '  - limit: 10',
    'max_tokens: 200',
  ]);
  // 1ページには収まらないが next_offset で追える = 運用上は引ける
  assert.ok(runQuery(osDir, 'tight_budget', {}).truncated);
  const r = auditReachability(osDir);
  assert.deepStrictEqual(r.unreachable, []);
  assert.strictEqual(r.violations, 0);
  assert.strictEqual(r.truncating.length, 1); // 「ページングが必要」は情報として残る
});
