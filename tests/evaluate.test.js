'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');

test('deterministic: file/queryチェックとFAIL', () => {
  const { root, osDir } = makeOs();
  write(root, 'README.md', '# hello\n');
  write(root, 'src/app.js', 'console.log("debug");\n');
  write(osDir, 'evaluators/no_console.yaml', [
    'id: no_console',
    'applies_to: repo_change',
    'tier: T0',
    'method: deterministic',
    'checks:',
    '  - kind: file_exists',
    '    path: README.md',
    '  - kind: file_not_matches',
    '    path: src/app.js',
    '    pattern: "console\\.log"',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'テスト', ['no_console']);
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(results[0].verdict, 'FAIL');
  assert.ok(results[0].evidence.some((e) => e.includes('NG')));
  // 修正するとPASS
  fs.writeFileSync(`${root}/src/app.js`, 'const x = 1;\n', 'utf8');
  const second = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(second.results[0].verdict, 'PASS');
});

test('command: exit codeで判定、起動失敗はUNCERTAIN', () => {
  const { root, osDir } = makeOs();
  write(root, 'ok.js', 'process.exit(0);\n');
  write(osDir, 'evaluators/run_ok.yaml', [
    'id: run_ok',
    'applies_to: repo_change',
    'tier: T0',
    'method: command',
    'argv: [node, ok.js]',
    'expect_exit: 0',
  ].join('\n'));
  write(osDir, 'evaluators/run_missing.yaml', [
    'id: run_missing',
    'applies_to: repo_change',
    'tier: T0',
    'method: command',
    'argv: [no-such-binary-xyz]',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'cmd', ['run_ok', 'run_missing']);
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(results[0].verdict, 'PASS');
  assert.strictEqual(results[1].verdict, 'UNCERTAIN');
});

test('llm_judge: briefing生成とverdict記録、evidence必須', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [statement('S0001', 'constraint', '制約')]);
  write(osDir, 'queries/get_constraints.yaml', [
    'name: get_constraints',
    'description: 制約',
    'pipeline:',
    '  - select: { type: constraint }',
  ].join('\n'));
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'context_queries: [get_constraints]',
    'rubric: |',
    '  要件を満たしているか判定せよ。',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'judge対象', ['judge']);
  const { results } = evaluate.evaluateTask(osDir, t.id);
  assert.strictEqual(results[0].pending, true);
  const briefing = fs.readFileSync(results[0].briefing, 'utf8');
  assert.ok(briefing.includes('独立評価'));
  assert.ok(briefing.includes('制約')); // Query出力が埋め込まれる
  // evidenceなしのverdictは拒否
  assert.throws(
    () => evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'judge', verdict: 'PASS', evidence: [] }),
    /evidence/
  );
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'judge', verdict: 'PASS', evidence: ['briefing確認'], tier: 'T2' });
  const latest = evaluate.latestVerdicts(osDir, t.id);
  assert.strictEqual(latest.judge.verdict, 'PASS');
});

test('next-action: 決定的FAILはLLMのPASSで覆せない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, 'precedence', ['det', 'judge']);
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'det', verdict: 'FAIL', evidence: ['x'], provenance: 'deterministic' });
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'judge', verdict: 'PASS', evidence: ['y'], provenance: 'llm' });
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'FIX');
  assert.ok(r.why.includes('覆せない'));
});

test('next-action: §11の写像（UNCERTAIN/insufficient/model_limitation/missing/DONE）', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, 'map', ['a', 'b']);
  // 片方未記録 → COLLECT_EVIDENCE
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'a', verdict: 'PASS', evidence: ['e'], provenance: 'deterministic' });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'COLLECT_EVIDENCE');
  // UNCERTAIN(model_limitation) → DEEP_RESEARCH
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'b', verdict: 'UNCERTAIN', evidence: ['e'], reason: 'model_limitation' });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'DEEP_RESEARCH');
  // UNCERTAIN(理由なし) → INVESTIGATE
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'b', verdict: 'UNCERTAIN', evidence: ['e'] });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'INVESTIGATE');
  // 全PASS → DONE（タスクstatusも更新される）
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'b', verdict: 'PASS', evidence: ['e'] });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'DONE');
  assert.strictEqual(evaluate.getTask(osDir, t.id).status, 'done');
});
