'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');
const path = require('node:path');
const context = require('../core/context');
const { buildReasoningContext } = context;
const { estimateTokens } = require('../core/util');

// 「関連するもの」と「同じ型のもの全部」を区別できるか。区別できなければ
// Reasoning Contextは名前だけの飾りで、実体は従来の全文埋め込みと変わらない。
test('Reasoning Context: 無関係なStatementは混入せず、1ホップ先のcountersは含まれる', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', 'ログイン処理はトークン検証を必ず通す', { tags: ['auth'] }),
    // 反証。task語とは一致しないが、S0001から counters で1ホップ届く
    statement('S0002', 'observation', '本番環境では有効期限を30分に短縮した', {
      tags: ['incident'],
      links: [{ role: 'counters', to: 'S0001' }],
    }),
    // 支持。同じく1ホップ
    statement('S0003', 'evidence', '監査ログに失敗回数が残っている', {
      tags: ['incident'],
      links: [{ role: 'supports', to: 'S0001' }],
    }),
    // 完全に無関係な領域。語もタグも一致せず、リンクも無い
    statement('S0004', 'constraint', '請求書の締め日は月末である', { tags: ['billing'] }),
  ]);
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'rubric: 要件を満たすか',
  ].join('\n'));
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const task = evaluate.newTask(osDir, 'ログイン処理のトークン検証を実装する', ['judge']);

  const ctx = buildReasoningContext(osDir, { task, evaluator: def });
  const ids = ctx.entries.map((e) => e.id);
  assert.ok(ids.includes('S0001'), JSON.stringify(ctx.entries));
  assert.ok(ids.includes('S0002'), '反証（counters）が1ホップで入らない');
  assert.ok(ids.includes('S0003'), '根拠（supports）が1ホップで入らない');
  assert.ok(!ids.includes('S0004'), '無関係タグのStatementが混入した');
  // 反証は支持より強く重み付けする（都合の良い証拠だけが残る選抜にしない）
  const counters = ctx.entries.find((e) => e.id === 'S0002');
  const supports = ctx.entries.find((e) => e.id === 'S0003');
  assert.ok(counters.sources.includes('1ホップ:counters'), JSON.stringify(counters));
  assert.ok(counters.score > supports.score, `counters=${counters.score} supports=${supports.score}`);
  // 直接一致した種が1ホップ先より上位に来る
  assert.strictEqual(ids[0], 'S0001');
});

test('Reasoning Context: evaluatorのcontext_queriesの結果を種にする', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', '外部依存を足さない', { tags: ['core'] }),
    statement('S0002', 'observation', '無関係な観測', { tags: ['other'] }),
  ]);
  write(osDir, 'queries/get_constraints.yaml', [
    'name: get_constraints',
    'description: 制約',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - project: [id, body, tags]',
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
  const task = evaluate.newTask(osDir, 'なにかの作業', ['judge']);
  const ctx = buildReasoningContext(osDir, { task, evaluator: def });
  assert.deepStrictEqual(ctx.entries.map((e) => e.id), ['S0001']);
  assert.ok(ctx.entries[0].sources.includes('query:get_constraints'));
  assert.deepStrictEqual(ctx.queries, ['get_constraints']);
});

test('Reasoning Context: maxTokensで切り、切ったことを明示する', () => {
  const { osDir } = makeOs();
  const many = [];
  for (let i = 1; i <= 20; i++) {
    many.push(statement(`S${String(i).padStart(4, '0')}`, 'constraint', `検証規律その${i}: ${'あ'.repeat(120)}`, { tags: ['discipline'] }));
  }
  store.assertStatements(osDir, many);
  write(osDir, 'queries/all_constraints.yaml', [
    'name: all_constraints',
    'description: 全制約',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - limit: 100',
    'max_tokens: 20000',
  ].join('\n'));
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'context_queries: [all_constraints]',
    'rubric: 要件を満たすか',
  ].join('\n'));
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const task = evaluate.newTask(osDir, '検証規律を守る', ['judge']);
  const ctx = buildReasoningContext(osDir, { task, evaluator: def, maxTokens: 400 });
  assert.ok(ctx.truncated, '予算超過なのに切り詰めが立っていない');
  assert.ok(ctx.entries.length < ctx.candidates);
  assert.ok(ctx.tokens_est <= 500, `tokens_est=${ctx.tokens_est}`);
  assert.ok(ctx.lines.join('\n').includes('省略'), '省略した事実がbriefingに書かれていない');
});

test('briefing: 既定は最小Subgraph、fullContext=trueで旧方式の全文埋め込みに戻る', () => {
  const { osDir } = makeOs();
  const many = [];
  for (let i = 1; i <= 30; i++) {
    many.push(statement(`S${String(i).padStart(4, '0')}`, 'constraint', `検証規律その${i}: ${'あ'.repeat(150)}`, { tags: ['discipline'] }));
  }
  store.assertStatements(osDir, many);
  write(osDir, 'queries/all_constraints.yaml', [
    'name: all_constraints',
    'description: 全制約',
    'pipeline:',
    '  - select: { type: constraint }',
    '  - limit: 100',
    'max_tokens: 20000',
  ].join('\n'));
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'context_queries: [all_constraints]',
    'rubric: 要件を満たすか',
  ].join('\n'));
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const task = evaluate.newTask(osDir, 'lookahead監査を実装する', ['judge']);

  const minimal = fs.readFileSync(evaluate.prepareLlmJudge(osDir, def, { task }), 'utf8');
  const full = fs.readFileSync(evaluate.prepareLlmJudge(osDir, def, { task, fullContext: true }), 'utf8');
  assert.ok(minimal.includes('## Reasoning Context'), minimal.slice(0, 400));
  assert.ok(!minimal.includes('## Query: all_constraints'));
  assert.ok(full.includes('## Query: all_constraints'));
  // 同一fixtureで、最小Subgraphのbriefingは旧方式より小さい
  assert.ok(
    estimateTokens(minimal) < estimateTokens(full),
    `minimal=${estimateTokens(minimal)} full=${estimateTokens(full)}`
  );
  // 他の節（Artifact・検証実績・実装の有無・Rubric・出力方法）は両方式で維持される
  for (const section of ['## Artifact', '## OSが記録した検証実績', '## Rubric', '## 出力方法']) {
    assert.ok(minimal.includes(section), `${section} が最小briefingから消えた`);
    assert.ok(full.includes(section), `${section} が全文briefingから消えた`);
  }
  assert.ok(minimal.includes('実装（ソースコード）が含まれていない'));
});

test('verdict: insufficient_sample（検出力不足）を受理する', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '標本が足りない', ['judge']);
  const entry = evaluate.recordVerdict(osDir, {
    task: t.id,
    evaluator: 'judge',
    verdict: 'UNCERTAIN',
    evidence: ['営業日66件では検出下限に届かない'],
    reason: 'insufficient_sample',
  });
  assert.strictEqual(entry.reason, 'insufficient_sample');
  assert.strictEqual(evaluate.latestVerdicts(osDir, t.id).judge.reason, 'insufficient_sample');
  assert.throws(
    () => evaluate.recordVerdict(osDir, {
      task: t.id, evaluator: 'judge', verdict: 'UNCERTAIN', evidence: ['x'], reason: 'small_sample',
    }),
    /reasonは/
  );
});

test('deliverContext: 実行側にも最小Subgraphを配り、消費を機械記録に残す', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    { type: 'constraint', body: 'retryは指数backoffで実装すること', tags: ['retry'], status: 'fact', provenance: { source: 'test', method: 'deterministic' } },
    { type: 'observation', body: '請求書の締め日は月末である', tags: ['billing'], status: 'fact', provenance: { source: 'test', method: 'deterministic' } },
  ]);
  const r = context.deliverContext(osDir, { purpose: 'retryの実装方針をサブエージェントに委ねる' });
  const text = r.lines.join('\n');
  assert.match(text, /## Reasoning Context/);
  assert.match(text, /retryは指数backoff/);
  assert.ok(!text.includes('請求書の締め日'), '無関係な話題は配らない');

  const rows = fs.readFileSync(path.join(osDir, 'observations', 'context_log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.filter((x) => x.kind === 'context').pop();
  assert.strictEqual(row.task, 'ad-hoc');
  assert.strictEqual(row.purpose, 'retryの実装方針をサブエージェントに委ねる');
  assert.ok(row.tokens_est > 0);
  assert.strictEqual(row.entries, r.entries.length);
});

test('deliverContext: taskもpurposeも無ければ配らない（何の文脈かが決まらない）', () => {
  const { osDir } = makeOs();
  assert.throws(() => context.deliverContext(osDir, {}), /--task または --purpose/);
});
