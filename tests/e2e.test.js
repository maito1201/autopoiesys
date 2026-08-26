'use strict';
// ヘッドレスE2E: LLM応答を記録済みverdict/findingsに置換して閉ループ1周を検証する。
// init → goal → ingest → World Model → Query → Task → 独立評価 → Next Action →
// feedback → Failure状態機械 → golden task（検出力テスト付き）→ regression → metrics
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const schema = require('../core/schema');
const evaluate = require('../core/evaluate');
const failure = require('../core/failure');
const regression = require('../core/regression');
const metrics = require('../core/metrics');
const knowledge = require('../core/knowledge');
const { ingestRepo } = require('../core/ingest');

test('閉ループ1周（Phase 1〜3の垂直スライス）', () => {
  const { root, osDir } = makeOs();

  // --- Phase 1: goal + ingest + World Model ---
  write(root, 'src/retry.js', 'function retry(f) { return f(); } // TODO idempotency\n');
  write(osDir, 'goal.yaml', [
    'goal: このリポジトリの変更の完了判定を蓄積したい',
    'domain: software_engineering',
    'objectives:',
    '  - fix_bugs',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: 変更が要件を満たす',
    '    evaluator: requirement_satisfied',
    '  - id: sc-002',
    '    statement: 回帰がない',
    '    evaluator: unbound',
    'constraints:',
    '  - id: c-001',
    '    statement: retryは冪等でなければならない',
    '    severity: hard',
    '    evaluator: no_unsafe_retry',
    'autonomy:',
    '  escalate_on:',
    '    - high_risk_change',
    'optimization:',
    '  - correctness',
    'sources:',
    '  - repo: .',
  ].join('\n'));

  const v = schema.validate(osDir);
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.unbound.length, 1); // sc-002が未接地として可視化される

  const ing = ingestRepo(osDir, root);
  assert.ok(ing.added.length >= 2);
  // 再実行は冪等
  const ing2 = ingestRepo(osDir, root);
  assert.strictEqual(ing2.added.length, 0);

  // Research(T3相当)の構造化findingsをcompileで資産化（ヘッドレスでは記録済みfindings）
  const r = knowledge.researchOpen(osDir, 'ドメイン調査');
  const compiled = knowledge.compileFindings(osDir, {
    session: r.id,
    claims: [
      { id: 'S9001', type: 'constraint', body: 'retryは冪等性キーを持つこと', status: 'fact', tags: ['repo'] },
      { id: 'S9002', type: 'hypothesis', body: 'retry実装は二重処理の危険がある', status: 'hypothesis', confidence: 0.7, links: [{ role: 'about', to: 'S9001' }] },
    ],
    candidates: [
      { kind: 'evaluator', name: 'no_unsafe_retry', note: 'retry実装に冪等性ガードがあることを検査' },
    ],
  });
  assert.deepStrictEqual(compiled.statements_added, ['S9001', 'S9002']);
  assert.strictEqual(compiled.proposals.length, 1);
  const closed = knowledge.researchClose(osDir, r.id, ['evaluators/no_unsafe_retry.yaml']);
  assert.strictEqual(closed.warning, null);

  // --- Phase 2: Query + Evaluator + Task + 独立評価 ---
  write(osDir, 'queries/get_constraints.yaml', [
    'name: get_constraints',
    'description: 有効な制約',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - project: [id, body, status]',
    'max_tokens: 1500',
    'golden:',
    '  expect_min_count: 1',
  ].join('\n'));
  write(osDir, 'evaluators/no_unsafe_retry.yaml', [
    'id: no_unsafe_retry',
    'applies_to: repo_change',
    'tier: T0',
    'method: deterministic',
    'checks:',
    '  - kind: file_not_matches',
    '    path: src/retry.js',
    '    pattern: "TODO idempotency"',
  ].join('\n'));
  write(osDir, 'evaluators/requirement_satisfied.yaml', [
    'id: requirement_satisfied',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'context_queries: [get_constraints]',
    'rubric: |',
    '  goalのsuccess_criteriaを満たしているか判定せよ。',
  ].join('\n'));

  const task = evaluate.newTask(osDir, 'retryの冪等性を実装する', ['no_unsafe_retry', 'requirement_satisfied']);
  evaluate.updateTask(osDir, task.id, { artifacts: [{ path: 'src/retry.js', note: '対象' }] });

  // 1回目の評価: 決定的評価がFAIL → next-action=FIX（LLMのPASSでは覆らない）
  let res = evaluate.evaluateTask(osDir, task.id, { workDir: root });
  assert.strictEqual(res.results.find((x) => x.evaluator === 'no_unsafe_retry').verdict, 'FAIL');
  evaluate.recordVerdict(osDir, {
    task: task.id, evaluator: 'requirement_satisfied', verdict: 'PASS',
    evidence: ['記録済みLLM判定'], provenance: 'llm', tier: 'T2', tokens: 800,
  });
  assert.strictEqual(evaluate.nextAction(osDir, task.id).action, 'FIX');

  // 修正して再評価 → DONE
  write(root, 'src/retry.js', 'function retry(f, key) { seen.add(key); return f(); }\nconst seen = new Set();\n');
  res = evaluate.evaluateTask(osDir, task.id, { workDir: root, replay: { requirement_satisfied: 'PASS' } });
  const na = evaluate.nextAction(osDir, task.id);
  assert.strictEqual(na.action, 'DONE');

  // --- Phase 3: feedback → Failure状態機械 → golden task → regression ---
  const fb = failure.report(osDir, { symptom: 'retry修正がタイムアウト値を壊した', severity: 'high', task: task.id });
  failure.transition(osDir, fb.entry.id, 'investigated', {
    root_cause: 'timeout値の回帰を検査するevaluatorがない',
    why_undetected: 'success_criteria sc-002（回帰なし）がunboundのままだった',
  });
  failure.transition(osDir, fb.entry.id, 'classified', { classification: 'missing_evaluator' });
  failure.transition(osDir, fb.entry.id, 'upgrade_proposed', { proposal: 'timeout_check evaluator + golden task gt-001' });

  // アップグレード適用: 新evaluator + 検出力テスト付きgolden task
  write(osDir, 'evaluators/timeout_check.yaml', [
    'id: timeout_check',
    'applies_to: repo_change',
    'tier: T0',
    'method: deterministic',
    'checks:',
    '  - kind: file_not_matches',
    '    path: src/retry.js',
    '    pattern: "timeout\\s*=\\s*0"',
  ].join('\n'));
  write(root, 'fixtures/bad-timeout/src/retry.js', 'const timeout = 0; // 既知の悪い状態\n');
  write(osDir, 'golden_tasks/gt-001.yaml', [
    'id: gt-001',
    'description: timeout回帰の検出力テスト',
    `origin_failure: ${fb.entry.id}`,
    'checks:',
    '  - evaluator: timeout_check',
    '    expected: PASS',
    '  - evaluator: timeout_check',
    '    fixture: fixtures/bad-timeout',
    '    expected: FAIL', // 検出器が既知の悪い状態を実際に検出できること
    '  - evaluator: requirement_satisfied',
    '    replay: PASS',
  ].join('\n'));

  const reg1 = regression.runRegression(osDir, { repoRoot: root });
  assert.strictEqual(reg1.pass, true, JSON.stringify({ errors: reg1.check_errors, lint: reg1.failure_lint, golden: reg1.golden }, null, 1));
  assert.strictEqual(reg1.golden_passed, 1);
  // 検出力テスト: fixtureに対して実際にFAILが出ている
  const detection = reg1.golden[0].checks.find((c) => c.fixture);
  assert.strictEqual(detection.actual, 'FAIL');

  // regression通過を根拠にimplementedへ遷移（資産強制を満たす）
  failure.transition(osDir, fb.entry.id, 'implemented', {
    assets: [
      { kind: 'golden_task', ref: 'golden_tasks/gt-001.yaml' },
      { kind: 'evaluator', ref: 'evaluators/timeout_check.yaml' },
    ],
    regression_ref: 'regression@reg1',
  });
  assert.strictEqual(failure.loadFailures(osDir)[fb.entry.id].state, 'implemented');

  // --- Token Economics: ledgerとmetrics ---
  knowledge.ledgerAdd(osDir, { purpose: 'run-task', tier: 'T2', tokens_in: 3000, tokens_out: 1200, task: task.id });
  knowledge.ledgerAdd(osDir, { purpose: 'investigate-failure', tier: 'T3', tokens_in: 8000, tokens_out: 2000, session: r.id });
  const m = metrics.computeMetrics(osDir);
  assert.strictEqual(m.tasks.done, 1);
  assert.strictEqual(m.failures.open, 0);
  assert.ok(m.tokens.by_tier.T3 > 0);
  assert.strictEqual(m.verdicts.counts.FAIL >= 1, true);

  // 資産ゼロで閉じたResearchは警告される（§14の出口検査）
  const r2 = knowledge.researchOpen(osDir, '空調査');
  const closedEmpty = knowledge.researchClose(osDir, r2.id, []);
  assert.ok(closedEmpty.warning && closedEmpty.warning.includes('raw reasoning'));
});
