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
  // UNCERTAIN(理由なし)が1回 → INVESTIGATE（連続していない状態を別タスクで確認する）
  const t2 = evaluate.newTask(osDir, 'map-single-uncertain', ['a']);
  evaluate.recordVerdict(osDir, { task: t2.id, evaluator: 'a', verdict: 'UNCERTAIN', evidence: ['e'] });
  assert.strictEqual(evaluate.nextAction(osDir, t2.id).action, 'INVESTIGATE');
  // 同じevaluatorのUNCERTAINが2回続いたら DEEP_RESEARCH へ昇格する
  // （同じ強さで調べ直しても解けなかったという記録。詳細は next-action-escalation.test.js）
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'b', verdict: 'UNCERTAIN', evidence: ['e'] });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'DEEP_RESEARCH');
  // 全PASS → DONE（タスクstatusも更新される）
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'b', verdict: 'PASS', evidence: ['e'] });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'DONE');
  assert.strictEqual(evaluate.getTask(osDir, t.id).status, 'done');
});

test('task: work_dir/refs/notesの引き継ぎ文脈と、evaluateのwork_dirフォールバック', () => {
  const { root, osDir } = makeOs();
  write(root, 'wt/ok.js', 'process.exit(0);\n');
  write(osDir, 'evaluators/run_ok.yaml', [
    'id: run_ok',
    'applies_to: repo_change',
    'tier: T0',
    'method: command',
    'argv: [node, ok.js]',
    'expect_exit: 0',
  ].join('\n'));
  const t = evaluate.newTask(osDir, '引き継ぎ', ['run_ok'], {
    work_dir: `${root}/wt`,
    refs: ['https://example.com/issues/1'],
    context: 'worktreeで作業',
  });
  assert.strictEqual(t.work_dir, `${root}/wt`);
  assert.deepStrictEqual(t.refs, ['https://example.com/issues/1']);
  // work-dir未指定でも task.work_dir で ok.js が解決される
  const { results } = evaluate.evaluateTask(osDir, t.id);
  assert.strictEqual(results[0].verdict, 'PASS');
  // 明示指定はtask.work_dirより優先される（ok.jsが無いdirではexit≠0=FAIL）
  const override = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(override.results[0].verdict, 'FAIL');
  // noteは追記され、latest行に累積する
  evaluate.addTaskNote(osDir, t.id, '調査完了');
  const after = evaluate.addTaskNote(osDir, t.id, '実装完了');
  assert.deepStrictEqual(after.notes.map((n) => n.note), ['調査完了', '実装完了']);
  assert.ok(after.notes.every((n) => n.ts));
  assert.throws(() => evaluate.addTaskNote(osDir, t.id, ''), /noteが必要/);
});

test('next-action DONE: 接地していない成功基準をcaveatsとして必ず添える', () => {
  const { osDir } = makeOs();
  write(osDir, 'evaluators/bound.yaml', [
    'id: bound',
    'applies_to: task_artifact',
    'tier: T0',
    'kind: outcome',
    'method: deterministic',
    'checks:',
    '  - kind: file_exists',
    '    path: README.md',
  ].join('\n'));
  write(osDir, 'goal.yaml', [
    'goal: 何かを達成する',
    'domain: software_engineering',
    'objectives:',
    '  - do_it',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: 測れる基準',
    '    evaluator: bound',
    '  - id: sc-002',
    '    statement: 啓蒙性が高い',
    '    evaluator: unbound',
    'constraints: []',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'caveats', ['bound']);
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'bound', verdict: 'PASS', evidence: ['e'], provenance: 'deterministic' });
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'DONE');
  // evaluatorがPASSしても、判定器の無い目的は「測れていない」と明示される
  assert.ok(r.caveats.some((c) => c.includes('sc-002') && c.includes('測定できていない')), JSON.stringify(r.caveats));
  // 実行実績のあるbound側はcaveatに現れない
  assert.ok(!r.caveats.some((c) => c.includes('sc-001')), JSON.stringify(r.caveats));
});

test('briefing: 実行済みverdictを機械記録として同梱し、0件なら裏付け無しと明示する', () => {
  const { osDir } = makeOs();
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_report',
    'tier: T1',
    'method: llm_judge',
    'rubric: 報告の検証主張に証跡があるか',
  ].join('\n'));
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const t = evaluate.newTask(osDir, '報告の裏付け', ['judge']);
  const before = fs.readFileSync(evaluate.prepareLlmJudge(osDir, def, { task: t }), 'utf8');
  assert.ok(before.includes('このタスクで記録されたverdictは0件'), before);
  evaluate.recordVerdict(osDir, {
    task: t.id, evaluator: 'unit_test', verdict: 'PASS', evidence: ['npm test: exit 0'], provenance: 'deterministic',
  });
  const after = fs.readFileSync(evaluate.prepareLlmJudge(osDir, def, { task: t }), 'utf8');
  assert.ok(after.includes('unit_test: PASS'), after);
  assert.ok(after.includes('npm test: exit 0'), after);
  // 判定中のevaluator自身は同梱しない（自己参照になる）
  assert.ok(!/^- judge:/m.test(after), after);
});

test('evaluator kind: conformance|outcome 以外は定義エラー', () => {
  assert.deepStrictEqual(
    evaluate.validateEvaluatorDef({ id: 'x', tier: 'T0', method: 'llm_judge', rubric: 'r', kind: 'process' }),
    ['kindは conformance|outcome']
  );
  assert.deepStrictEqual(
    evaluate.validateEvaluatorDef({ id: 'x', tier: 'T0', method: 'llm_judge', rubric: 'r', kind: 'outcome' }),
    []
  );
});
