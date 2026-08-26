'use strict';
// 敵対的レビューで確認された欠陥の回帰テスト群
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');
const { runQuery } = require('../core/query');
const { parseYaml } = require('../core/yaml');
const knowledge = require('../core/knowledge');
const { ingestRepo } = require('../core/ingest');

test('外部verdict: deterministic評価は受理せず、provenance偽装は矯正される（§26③）', () => {
  const { root, osDir } = makeOs();
  write(root, 'x.txt', 'ng\n');
  write(osDir, 'evaluators/det_check.yaml', [
    'id: det_check',
    'applies_to: repo_change',
    'tier: T0',
    'method: deterministic',
    'checks:',
    '  - kind: file_absent',
    '    path: x.txt',
  ].join('\n'));
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'rubric: |',
    '  判定せよ',
  ].join('\n'));
  const t = evaluate.newTask(osDir, '偽装テスト', ['det_check', 'judge']);
  evaluate.evaluateTask(osDir, t.id, { workDir: root });
  // 決定的FAILを外部verdictのPASSで上書きしようとする → 拒否される
  assert.throws(
    () => evaluate.recordVerdict(osDir, {
      task: t.id, evaluator: 'det_check', verdict: 'PASS', evidence: ['自己申告'],
    }, { external: true }),
    /llm_judge/
  );
  // provenance偽装（deterministicを自称）はllmに矯正される
  const v = evaluate.recordVerdict(osDir, {
    task: t.id, evaluator: 'judge', verdict: 'PASS', evidence: ['briefing確認'], provenance: 'deterministic',
  }, { external: true });
  assert.strictEqual(v.provenance, 'llm');
  // 決定的FAILが残っているのでnext-actionはFIXのまま
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'FIX');
});

test('同一evaluatorでも決定的FAILは後続のllm verdictで覆らない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '上書き耐性', ['det_check']);
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'det_check', verdict: 'FAIL', evidence: ['x'], provenance: 'deterministic' });
  // 内部経路を悪用してllm PASSを同一evaluatorに積んでも、最新の決定的verdictがFAILなら覆らない
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'det_check', verdict: 'PASS', evidence: ['y'], provenance: 'llm' });
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'FIX');
});

test('evaluatorをタスクから外しても記録済みFAILは視界から消えない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '審査員外し', ['a', 'b']);
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'a', verdict: 'PASS', evidence: ['e'] });
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'b', verdict: 'FAIL', evidence: ['e'] });
  evaluate.updateTask(osDir, t.id, { evaluators: ['a'] }); // FAILしたbを外す
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'FIX');
});

test('一度DONEでも新たなFAILでstatusがopenに戻る', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '再開テスト', ['a']);
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'a', verdict: 'PASS', evidence: ['e'] });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'DONE');
  assert.strictEqual(evaluate.getTask(osDir, t.id).status, 'done');
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'a', verdict: 'FAIL', evidence: ['e'], provenance: 'deterministic' });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'FIX');
  assert.strictEqual(evaluate.getTask(osDir, t.id).status, 'open');
});

test('limit無しQueryのtotalは絞り込み後の件数（query_empty判定の基盤）', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'observation', 'a'),
    statement('S0002', 'observation', 'b'),
  ]);
  write(osDir, 'queries/find_constraints.yaml', [
    'name: find_constraints',
    'description: x',
    'pipeline:',
    '  - select: { type: constraint }',
  ].join('\n'));
  const r = runQuery(osDir, 'find_constraints', {});
  assert.strictEqual(r.total, 0); // 修正前は全Statement数(2)を返していた
});

test('tagsが配列でないStatementは拒否される', () => {
  const { osDir } = makeOs();
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0001', 'claim', 'x', { tags: 'repo' })]),
    /tagsは文字列の配列/
  );
});

test('YAML: プレーンスカラー中のアポストロフィでコメントが値に混入しない', () => {
  const v = parseYaml("note: it's fine # comment\nlist: [it's, x]\n");
  assert.strictEqual(v.note, "it's fine");
  assert.deepStrictEqual(v.list, ["it's", 'x']);
  // 既存の引用挙動は維持
  const w = parseYaml("b: 'it''s # not a comment'\n");
  assert.strictEqual(w.b, "it's # not a comment");
});

test('compile提案のkind別格納先が実在ディレクトリを指す（querys回帰）', () => {
  const { osDir } = makeOs();
  const r = knowledge.compileFindings(osDir, {
    candidates: [
      { kind: 'query', name: 'find_gaps', note: 'x' },
      { kind: 'detector', name: 'dup_check', note: 'y' },
    ],
  });
  const q = fs.readFileSync(r.proposals[0], 'utf8');
  assert.ok(q.includes('.os/queries/'));
  assert.ok(!q.includes('querys'));
  const d = fs.readFileSync(r.proposals[1], 'utf8');
  assert.ok(d.includes('.os/evaluators/'));
});

test('ingest再実行: 内容が変わった観測は旧観測をsupersedeし矛盾が併存しない', () => {
  const { root, osDir } = makeOs();
  write(root, 'a.txt', '1');
  ingestRepo(osDir, root);
  write(root, 'b.txt', '2'); // inventoryとlayoutが変化する
  ingestRepo(osDir, root);
  const snap = store.rebuildSnapshot(osDir);
  const inventories = Object.values(snap.statements)
    .filter((s) => s.type === 'observation' && (s.tags || []).includes('inventory'));
  assert.strictEqual(inventories.length, 1); // 現在状態には最新のみ
  assert.ok(inventories[0].body.includes('総数2'));
});

test('--replayは記録済みの独立判定と一致する場合のみ受理される（迂回防止）', () => {
  const { osDir } = makeOs();
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'rubric: |',
    '  判定せよ',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'replay迂回', ['judge']);
  // 記録なしのreplay → 拒否
  assert.throws(
    () => evaluate.evaluateTask(osDir, t.id, { replay: { judge: 'PASS' } }),
    /replay不可/
  );
  // FAILが記録された後にPASSをreplay → 拒否
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'judge', verdict: 'FAIL', evidence: ['独立判定'], provenance: 'llm' });
  assert.throws(
    () => evaluate.evaluateTask(osDir, t.id, { replay: { judge: 'PASS' } }),
    /replay不一致/
  );
  // 一致するreplayは受理される
  const { results } = evaluate.evaluateTask(osDir, t.id, { replay: { judge: 'FAIL' } });
  assert.strictEqual(results[0].verdict, 'FAIL');
  assert.strictEqual(results[0].provenance, 'replay');
});

test('Evaluator/Query IDは定義内idとの厳密一致を要求（大小文字非区別FS対策）', () => {
  const { osDir } = makeOs();
  write(osDir, 'evaluators/tests_pass.yaml', [
    'id: tests_pass',
    'applies_to: repo_change',
    'tier: T0',
    'method: command',
    'argv: [node, -v]',
  ].join('\n'));
  assert.throws(() => evaluate.loadEvaluatorDef(osDir, 'Tests_Pass'), /不一致|存在しない/);
  write(osDir, 'queries/get_x.yaml', [
    'name: get_x',
    'description: x',
    'pipeline:',
    '  - select: { type: claim }',
  ].join('\n'));
  assert.throws(() => runQuery(osDir, 'GET_X', {}), /不一致|存在しない/);
});

test('checkは未完了タスクの存在しないevaluator参照を検出する', () => {
  const { osDir } = makeOs();
  const schema = require('../core/schema');
  evaluate.newTask(osDir, '参照壊れ', ['No_Such_Evaluator']);
  const r = schema.checkAll(osDir);
  assert.ok(r.errors.some((e) => e.includes('No_Such_Evaluator')));
});

test('file_matchesはUTF-16LE/BOM付きUTF-8の成果物も正しく読む', () => {
  const { root, osDir } = makeOs();
  // PowerShell 5.1 Out-File相当のUTF-16LE
  fs.mkdirSync(path.join(root, 'outdir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outdir', 'r16.md'), Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('provenance deterministic ok', 'utf16le'),
  ]));
  fs.writeFileSync(path.join(root, 'outdir', 'rbom.md'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('provenance deterministic ok', 'utf8'),
  ]));
  write(osDir, 'evaluators/doc16.yaml', [
    'id: doc16',
    'applies_to: repo_change',
    'tier: T0',
    'method: deterministic',
    'checks:',
    '  - kind: file_matches',
    '    path: outdir/r16.md',
    '    pattern: "^provenance.*deterministic"',
    '  - kind: file_matches',
    '    path: outdir/rbom.md',
    '    pattern: "^provenance.*deterministic"',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'エンコーディング', ['doc16']);
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(results[0].verdict, 'PASS', JSON.stringify(results[0].evidence));
});

test('commandのタイムアウトはプロセスツリーを殺しUNCERTAINを返す', () => {
  const { root, osDir } = makeOs();
  write(root, 'sleep.js', 'setTimeout(() => {}, 8000);\n');
  write(osDir, 'evaluators/slowcmd.yaml', [
    'id: slowcmd',
    'applies_to: repo_change',
    'tier: T0',
    'method: command',
    'argv: [node, sleep.js]',
    'timeout_ms: 700',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'timeout', ['slowcmd']);
  const start = Date.now();
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(results[0].verdict, 'UNCERTAIN');
  assert.ok(results[0].evidence.some((e) => e.includes('タイムアウト')));
  assert.ok(Date.now() - start < 6000); // 8秒待たされていない＝実際に殺している
});

test('research close: 予算超過で警告', () => {
  const { osDir } = makeOs();
  const r = knowledge.researchOpen(osDir, '高額調査');
  knowledge.ledgerAdd(osDir, { purpose: 'x', tier: 'T3', tokens_in: 900, tokens_out: 200, session: r.id });
  const closed = knowledge.researchClose(osDir, r.id, ['rules/x.yaml'], { budget: 1000 });
  assert.strictEqual(closed.tokens_spent, 1100);
  assert.ok(closed.warning.includes('予算'));
});
