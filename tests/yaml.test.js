'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseYaml } = require('../core/yaml');

test('マップとスカラー', () => {
  const v = parseYaml('name: get_x\ncount: 3\nratio: 0.5\nok: true\nnothing: null\n');
  assert.deepStrictEqual(v, { name: 'get_x', count: 3, ratio: 0.5, ok: true, nothing: null });
});

test('ネストしたマップとリスト', () => {
  const v = parseYaml([
    'goal: テスト',
    'objectives:',
    '  - a',
    '  - b',
    'autonomy:',
    '  escalate_on:',
    '    - risk',
    '',
  ].join('\n'));
  assert.deepStrictEqual(v, { goal: 'テスト', objectives: ['a', 'b'], autonomy: { escalate_on: ['risk'] } });
});

test('リスト項目がマップ（継続行つき）', () => {
  const v = parseYaml([
    'checks:',
    '  - evaluator: c1',
    '    expected: PASS',
    '  - evaluator: c2',
    '    fixture: fx/bad',
    '    expected: FAIL',
  ].join('\n'));
  assert.deepStrictEqual(v.checks, [
    { evaluator: 'c1', expected: 'PASS' },
    { evaluator: 'c2', fixture: 'fx/bad', expected: 'FAIL' },
  ]);
});

test('単一行フロースタイル', () => {
  const v = parseYaml([
    'pipeline:',
    '  - select: { type: constraint }',
    '  - where: { status: [fact, hypothesis] }',
    'argv: [node, --test, tests/]',
    'empty: {}',
    'nested: { a: { b: [1, 2] }, c: x }',
  ].join('\n'));
  assert.deepStrictEqual(v.pipeline, [
    { select: { type: 'constraint' } },
    { where: { status: ['fact', 'hypothesis'] } },
  ]);
  assert.deepStrictEqual(v.argv, ['node', '--test', 'tests/']);
  assert.deepStrictEqual(v.empty, {});
  assert.deepStrictEqual(v.nested, { a: { b: [1, 2] }, c: 'x' });
});

test('コメントと引用', () => {
  const v = parseYaml([
    '# 先頭コメント',
    'a: 1 # 行末コメント',
    "b: 'it''s # not a comment'",
    'c: "hash # inside"',
    'pattern: "console\\.log"',
  ].join('\n'));
  assert.strictEqual(v.a, 1);
  assert.strictEqual(v.b, "it's # not a comment");
  assert.strictEqual(v.c, 'hash # inside');
  assert.strictEqual(v.pattern, 'console\\.log');
});

test('リテラルブロック', () => {
  const v = parseYaml([
    'rubric: |',
    '  1行目',
    '  2行目',
    '',
    '    インデント保持',
    'after: 1',
  ].join('\n'));
  assert.strictEqual(v.rubric, '1行目\n2行目\n\n  インデント保持\n');
  assert.strictEqual(v.after, 1);
});

test('コロンを含む値', () => {
  const v = parseYaml('url: https://example.com/path\ndesc: 目的: 検証\n');
  assert.strictEqual(v.url, 'https://example.com/path');
  assert.strictEqual(v.desc, '目的: 検証');
});

test('非対応構文は明示エラー', () => {
  assert.throws(() => parseYaml('a: &anchor 1'), /非対応/);
  assert.throws(() => parseYaml('\ta: 1'), /タブ/);
});

test('空文書はnull', () => {
  assert.strictEqual(parseYaml(''), null);
  assert.strictEqual(parseYaml('# コメントだけ\n'), null);
});
