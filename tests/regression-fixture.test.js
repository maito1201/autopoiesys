'use strict';
// F008: golden taskの検出力テストは、fixtureに置かれた複製ではなく**本体の検出器**を実行する。
// fixtureをcwdにして相対パスのargvを実行すると、fixtureは検出器の複製を持たなければ動かず、
// その複製はfixture作成時点で凍結される — 本体を書き換えてもgoldenは緑のままになる。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeOs, write } = require('./helpers');
const { runRegression } = require('../core/regression');

const EVALUATOR = [
  'id: probe',
  'applies_to: repo_change',
  'tier: T0',
  'kind: conformance',
  'method: command',
  'argv: [node, scripts/probe.js, .os]',
  'expect_exit: 0',
  '',
].join('\n');

const GOLDEN = [
  'id: gt-probe',
  'description: fixture付きcommand check 1件',
  'checks:',
  '  - evaluator: probe',
  '    fixture: fixtures/target',
  '    expected: PASS',
  '',
].join('\n');

// 本体は成功して REAL を出す。fixture内の複製は失敗して SHADOW を出す。
// 実行されたのがどちらかは、verdictと出力の両方で見分けがつく
function setup({ withShadow }) {
  const { root, osDir } = makeOs();
  write(osDir, 'evaluators/probe.yaml', EVALUATOR);
  write(osDir, 'golden_tasks/gt-probe.yaml', GOLDEN);
  write(root, 'scripts/probe.js', 'process.stdout.write("REAL");process.exit(0);');
  write(root, 'fixtures/target/.keep', '');
  if (withShadow) {
    write(root, 'fixtures/target/scripts/probe.js', 'process.stdout.write("SHADOW");process.exit(1);');
  }
  return { root, osDir };
}

function probeCheck(result) {
  const g = result.golden.find((x) => x.id === 'gt-probe');
  return g.checks[0];
}

test('fixtureに複製があっても本体の検出器が実行される（複製は実行されない）', () => {
  const { root, osDir } = setup({ withShadow: true });
  const check = probeCheck(runRegression(osDir, { repoRoot: root }));
  const evidence = check.evidence.join(' ');
  assert.ok(evidence.includes('REAL'), '本体の出力が出る');
  assert.ok(!evidence.includes('SHADOW'), 'fixture内の複製は実行されない');
  assert.strictEqual(check.actual, 'PASS');
  // 何を実行したかがverdictの記録に残る（記録に出ないと、影を踏んでも緑のまま通る）
  assert.ok(evidence.includes(path.resolve(root, 'scripts/probe.js')));
  assert.ok(evidence.includes('fixture内に同名の複製があるが実行していない'));
});

test('複製が無くても同じ本体が実行され、証跡には解決した絶対パスが残る', () => {
  const { root, osDir } = setup({ withShadow: false });
  const check = probeCheck(runRegression(osDir, { repoRoot: root }));
  const evidence = check.evidence.join(' ');
  assert.ok(evidence.includes('REAL'));
  assert.ok(evidence.includes(path.resolve(root, 'scripts/probe.js')));
  assert.ok(!evidence.includes('複製があるが実行していない'));
});

// 本体を壊したらgoldenが赤くなること。これが起きないなら、まだ複製か別経路を見ている
test('本体の検出器を壊すとgoldenがFAILに転じる', () => {
  const { root, osDir } = setup({ withShadow: true });
  write(root, 'scripts/probe.js', 'process.stdout.write("BROKEN");process.exit(1);');
  const check = probeCheck(runRegression(osDir, { repoRoot: root }));
  assert.strictEqual(check.actual, 'FAIL');
  assert.strictEqual(check.pass, false);
});

// データ引数（.os や .）はfixtureを指し続ける必要がある。
// スクリプトだけを解決し、cwdは動かさないことの確認
test('cwdはfixtureのままで、データ引数はfixture側を指す', () => {
  const { root, osDir } = setup({ withShadow: false });
  write(root, 'scripts/probe.js', [
    'const fs = require("node:fs");',
    'process.stdout.write(fs.existsSync(".os/marker") ? "FIXTURE_OS" : "OTHER_OS");',
    'process.exit(fs.existsSync(".os/marker") ? 0 : 1);',
  ].join('\n'));
  write(root, 'fixtures/target/.os/marker', 'x');
  const check = probeCheck(runRegression(osDir, { repoRoot: root }));
  assert.ok(check.evidence.join(' ').includes('FIXTURE_OS'));
  assert.strictEqual(check.actual, 'PASS');
});
