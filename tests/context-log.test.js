'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');
const { runQuery } = require('../core/query');
const { computeMetrics } = require('../core/metrics');
const { readJsonl } = require('../core/util');

function contextLog(osDir) {
  return readJsonl(path.join(osDir, 'observations', 'context_log.jsonl'));
}

// Token Ledgerは自己申告。briefingの実サイズだけは機械が知っているので、
// ここを記録しない限り「Contextを小さくした」は測れない主張のままになる。
test('context_log: briefing生成のたびに実測トークンが1行追記される', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [statement('S0001', 'constraint', '外部依存を足さない', { tags: ['core'] })]);
  write(osDir, 'queries/get_constraints.yaml', [
    'name: get_constraints',
    'description: 制約',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - project: [id, body]',
  ].join('\n'));
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'context_queries: [get_constraints]',
    'rubric: 要件を満たすか',
  ].join('\n'));
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const task = evaluate.newTask(osDir, '外部依存なしで実装する', ['judge']);
  assert.strictEqual(contextLog(osDir).length, 0);

  evaluate.prepareLlmJudge(osDir, def, { task });
  const rows = contextLog(osDir);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'briefing');
  assert.strictEqual(rows[0].task, task.id);
  assert.strictEqual(rows[0].evaluator, 'judge');
  assert.ok(rows[0].tokens_est > 0, JSON.stringify(rows[0]));
  assert.ok(rows[0].ts);

  // evaluate経由（llm_judgeはbriefing生成のみ）でも記録される
  evaluate.evaluateTask(osDir, task.id);
  assert.strictEqual(contextLog(osDir).length, 2);
});

test('metrics: context.briefing_tokens_total / query_tokens_total / per_task を集計する', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [statement('S0001', 'constraint', '外部依存を足さない', { tags: ['core'] })]);
  write(osDir, 'queries/get_constraints.yaml', [
    'name: get_constraints',
    'description: 制約',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - project: [id, body]',
  ].join('\n'));
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'context_queries: [get_constraints]',
    'rubric: 要件を満たすか',
  ].join('\n'));
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const t1 = evaluate.newTask(osDir, '外部依存なしで実装する', ['judge']);
  const t2 = evaluate.newTask(osDir, '別のタスク', ['judge']);
  evaluate.prepareLlmJudge(osDir, def, { task: t1 });
  evaluate.prepareLlmJudge(osDir, def, { task: t1 });
  evaluate.prepareLlmJudge(osDir, def, { task: t2 });
  runQuery(osDir, 'get_constraints');

  const rows = contextLog(osDir);
  const total = rows.reduce((a, r) => a + r.tokens_est, 0);
  const t1Total = rows.filter((r) => r.task === t1.id).reduce((a, r) => a + r.tokens_est, 0);
  const m = computeMetrics(osDir);
  assert.strictEqual(m.context.briefing_tokens_total, total);
  assert.strictEqual(m.context.per_task[t1.id], t1Total);
  assert.strictEqual(Object.keys(m.context.per_task).length, 2);
  // query_log側の実測（briefingがcontext_queriesを引いた分＋直接実行分）
  const queryTokens = readJsonl(path.join(osDir, 'observations', 'query_log.jsonl'))
    .reduce((a, q) => a + (q.tokens_est || 0), 0);
  assert.strictEqual(m.context.query_tokens_total, queryTokens);
  assert.ok(m.context.query_tokens_total > 0);
});

test('metrics: context_logが無いOSでも集計は0で成立する', () => {
  const { osDir } = makeOs();
  const m = computeMetrics(osDir);
  assert.strictEqual(m.context.briefing_tokens_total, 0);
  assert.strictEqual(m.context.query_tokens_total, 0);
  assert.deepStrictEqual(m.context.per_task, {});
});
