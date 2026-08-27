'use strict';
// 横断タスクの完了認定の要件テスト。
// 検証する要件: ①Evaluatorがscopeを宣言していればそのリポジトリのdirで実行される
// ②実行先が決まらないEvaluatorは登録時に落ちる ③評価時に到達しても誤ったPASSを出さない
// ④llm_judgeのbriefingがタスクの対象リポジトリで絞られる
// ⑤知識がQueryの返却枠に実際に入るかを内容で検査できる
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');
const { appendJsonl } = require('../core/util');

// 自分のcwdのマーカーファイルの有無で「どこで実行されたか」を判定するEvaluator
function markerEvaluator(osDir, id, scope) {
  write(osDir, `evaluators/${id}.yaml`, [
    `id: ${id}`,
    'applies_to: repo_change',
    ...(scope ? [`scope: ${scope}`] : []),
    'tier: T0',
    'method: deterministic',
    'checks:',
    `  - kind: file_exists`,
    `    path: ${id}.marker`,
  ].join('\n'));
}

test('evaluatorのscopeで実行ディレクトリがルーティングされる（--work-dirでは上書きされない）', () => {
  const { root, osDir } = makeOs();
  const apiDir = path.join(root, 'api-worktree');
  const appDir = path.join(root, 'app-worktree');
  write(apiDir, 'api_check.marker', '');
  write(appDir, 'app_check.marker', '');
  markerEvaluator(osDir, 'api_check', 'api');
  markerEvaluator(osDir, 'app_check', 'app');
  const t = evaluate.newTask(osDir, '横断タスク', ['api_check', 'app_check'], {
    repo_dirs: { api: apiDir, app: appDir },
  });
  // 一括の--work-dirを渡してもscope付きevaluatorはそれぞれのdirで走る
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.deepStrictEqual(results.map((r) => r.verdict), ['PASS', 'PASS']);
});

test('scopeを持たないevaluatorは --work-dir で走る', () => {
  const { root, osDir } = makeOs();
  const other = path.join(root, 'elsewhere');
  write(other, 'common_check.marker', '');
  markerEvaluator(osDir, 'common_check', null);
  const t = evaluate.newTask(osDir, '単一タスク', ['common_check']);
  assert.strictEqual(evaluate.evaluateTask(osDir, t.id, { workDir: other }).results[0].verdict, 'PASS');
  assert.strictEqual(evaluate.evaluateTask(osDir, t.id, { workDir: root }).results[0].verdict, 'FAIL');
});

test('実行先が決まらないscope付きevaluatorはtask new時点で登録できない', () => {
  const { root, osDir } = makeOs();
  markerEvaluator(osDir, 'api_check', 'api');
  assert.throws(
    () => evaluate.newTask(osDir, '横断タスク', ['api_check'], { repo_dirs: { app: root } }),
    /実行先ディレクトリが未指定.*api_check\(scope=api\)/s
  );
  // 対象を足せば登録できる
  const t = evaluate.newTask(osDir, '横断タスク', ['api_check'], { repo_dirs: { api: root, app: root } });
  assert.deepStrictEqual(t.repo_dirs, { api: root, app: root });
});

test('登録済みタスクのdirが失われていたら誤ったPASSを出さずUNCERTAINにする', () => {
  const { root, osDir } = makeOs();
  write(root, 'api_check.marker', '');
  markerEvaluator(osDir, 'api_check', 'api');
  // 検証をすり抜ける経路（旧形式の台帳行など）を直接作る
  appendJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'), {
    id: 'T001', ts: '2026-08-27T00:00:00Z', objective: '旧形式', status: 'open', artifacts: [], evaluators: ['api_check'],
  });
  const { results } = evaluate.evaluateTask(osDir, 'T001', { workDir: root });
  assert.strictEqual(results[0].verdict, 'UNCERTAIN');
  assert.strictEqual(results[0].reason, 'insufficient_evidence');
  assert.match(results[0].evidence.join(''), /scope=api の作業ディレクトリ/);
});

test('query_matches: Queryの返却枠に知識が入っているかを内容で検査する', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', 'go build は禁止', { tags: ['playbook'], scope: ['api'] }),
    statement('S0002', 'constraint', 'EASでビルドする', { tags: ['playbook'], scope: ['app'] }),
  ]);
  write(osDir, 'queries/playbook.yaml', [
    'name: playbook',
    'description: 作法',
    'params:',
    '  scope: { required: true }',
    'pipeline:',
    '  - where: { tags: [playbook] }',
    '  - where_param: { field: scope, contains: scope }',
    '  - project: [id, body, scope]',
    '  - limit: 20',
    'max_tokens: 2000',
  ].join('\n'));
  write(osDir, 'evaluators/reach.yaml', [
    'id: reach',
    'applies_to: os_store',
    'tier: T0',
    'method: deterministic',
    'checks:',
    '  - kind: query_matches',
    '    query: playbook',
    '    params: { scope: api }',
    '    pattern: "go build"',
  ].join('\n'));
  const def = evaluate.loadEvaluatorDef(osDir, 'reach');
  assert.strictEqual(evaluate.runDeterministic(osDir, def, { workDir: osDir }).verdict, 'PASS');
  // 別scopeでは同じ知識が返らない = 検出力がある
  const other = { ...def, checks: [{ ...def.checks[0], params: { scope: 'app' } }] };
  const r = evaluate.runDeterministic(osDir, other, { workDir: osDir });
  assert.strictEqual(r.verdict, 'FAIL');
  assert.match(r.evidence.join(''), /no-match/);
  // query_not_matches は逆の判定になる
  const neg = { ...def, checks: [{ ...def.checks[0], kind: 'query_not_matches' }] };
  assert.strictEqual(evaluate.runDeterministic(osDir, neg, { workDir: osDir }).verdict, 'FAIL');
});

test('query_matchesはpattern必須', () => {
  const errors = evaluate.validateEvaluatorDef({
    id: 'x', method: 'deterministic', tier: 'T0',
    checks: [{ kind: 'query_matches', query: 'q' }],
  });
  assert.match(errors.join('\n'), /query_matches: pattern必須/);
});

test('evaluatorのscopeは非空文字列でなければエラー', () => {
  const errors = evaluate.validateEvaluatorDef({
    id: 'x', method: 'command', tier: 'T0', argv: ['node'], scope: '',
  });
  assert.match(errors.join('\n'), /scopeは非空の文字列/);
});

test('llm_judgeのbriefingはタスクの対象リポジトリでcontext_queriesを絞る', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', 'apiの作法', { tags: ['playbook'], scope: ['api'] }),
    statement('S0002', 'constraint', 'appの作法', { tags: ['playbook'], scope: ['app'] }),
    statement('S0003', 'constraint', 'webの作法', { tags: ['playbook'], scope: ['web'] }),
  ]);
  write(osDir, 'queries/playbook.yaml', [
    'name: playbook',
    'description: 作法',
    'params:',
    '  scope: { required: false }',
    'pipeline:',
    '  - where: { tags: [playbook] }',
    '  - where_param: { field: scope, contains: scope }',
    '  - project: [id, body, scope]',
    '  - limit: 20',
    'max_tokens: 2000',
  ].join('\n'));
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: repo_change',
    'tier: T2',
    'method: llm_judge',
    'context_queries: [playbook]',
    'rubric: 要件を満たすか',
  ].join('\n'));
  const t = evaluate.newTask(osDir, '横断タスク', ['judge'], { repo_dirs: { api: osDir, app: osDir } });
  const { results } = evaluate.evaluateTask(osDir, t.id);
  const briefing = require('node:fs').readFileSync(results[0].briefing, 'utf8');
  assert.match(briefing, /scope=api,app/);
  assert.match(briefing, /apiの作法/);
  assert.match(briefing, /appの作法/);
  assert.ok(!briefing.includes('webの作法')); // 触らないリポジトリの作法は入れない
});
