'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const { runQuery } = require('../core/query');
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
