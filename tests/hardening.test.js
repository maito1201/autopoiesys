'use strict';
// 敵対的レビューで確認された欠陥の回帰テスト群
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const evaluate = require('../core/evaluate');
const { runQuery } = require('../core/query');
const { parseYaml } = require('../core/yaml');
const knowledge = require('../core/knowledge');
const { ingestRepo } = require('../core/ingest');
const schema = require('../core/schema');
const regression = require('../core/regression');
const metrics = require('../core/metrics');

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

test('一度納品可能（DELIVER）でも新たなFAILでopen側に戻る', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '再開テスト', ['a']);
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'a', verdict: 'PASS', evidence: ['e'] });
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'DELIVER');
  assert.strictEqual(evaluate.getTask(osDir, t.id).status, 'open');
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

test('excluded_sources: 理由なしの除外は拒否される（取りこぼしの追認を防ぐ）', () => {
  const { osDir } = makeOs();
  const goalLines = (excluded) => [
    'goal: x',
    'domain: d',
    'objectives:',
    '  - o1',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: s',
    '    evaluator: unbound',
    'sources:',
    '  - repo: .',
    'excluded_sources:',
    ...excluded,
  ].join('\n');

  write(osDir, 'goal.yaml', goalLines(['  - path: ./AGENTS.md']));
  assert.match(schema.validate(osDir).errors.join(), /reason（なぜ取り込まないか）が必要/);

  write(osDir, 'goal.yaml', goalLines(['  - path: ./AGENTS.md', '    reason: CLAUDE.mdと同内容']));
  assert.deepStrictEqual(schema.validate(osDir).errors, []);
  // 除外は絶対パスに解決され、発見側と突き合わせられる
  const ex = schema.resolveExcludedSources(schema.loadGoal(osDir), osDir);
  assert.strictEqual(ex.length, 1);
  assert.ok(path.isAbsolute(ex[0].path));
});

test('maintenanceHints: 評価未実行のopenタスクを警告として中継経路に載せる', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '未評価のまま完成報告する経路', ['det', 'judge']);
  const before = regression.maintenanceHints(osDir);
  const warn = before.find((h) => h.startsWith('警告:') && h.includes(t.id));
  assert.ok(warn, JSON.stringify(before));
  assert.ok(warn.includes('det') && warn.includes('judge'), warn);
  // 片方だけ記録しても、残りが未記録なら警告は消えない
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'det', verdict: 'PASS', evidence: ['e'], provenance: 'deterministic' });
  assert.ok(regression.maintenanceHints(osDir).some((h) => h.includes(t.id) && h.includes('judge')));
  // 全て記録されれば消える
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'judge', verdict: 'PASS', evidence: ['e'] });
  assert.ok(!regression.maintenanceHints(osDir).some((h) => h.includes(t.id)));
});

test('ledger: トークンは任意。入れた値は既定で見積り扱いになり、実測と分けて集計される', () => {
  const { osDir } = makeOs();
  // 測れないなら入れない（0を捏造しない）
  const noTokens = knowledge.ledgerAdd(osDir, { purpose: 'run-task', tier: 'T2' });
  assert.strictEqual(noTokens.tokens_in, undefined);
  assert.strictEqual(noTokens.estimated, undefined);
  // 手入力は見積り
  const est = knowledge.ledgerAdd(osDir, { purpose: 'run-task', tier: 'T2', tokens_in: 18000, tokens_out: 1500 });
  assert.strictEqual(est.estimated, true);
  // API実測値だけが measured
  const measured = knowledge.ledgerAdd(osDir, { purpose: 'run-task', tier: 'T2', tokens_in: 10, tokens_out: 5, measured: true });
  assert.strictEqual(measured.estimated, false);
  // 片側だけの入力は集計を歪めるので拒否
  assert.throws(() => knowledge.ledgerAdd(osDir, { purpose: 'x', tier: 'T2', tokens_in: 100 }), /両方指定/);
  const m = metrics.computeMetrics(osDir);
  assert.strictEqual(m.tokens.estimated, 19500);
  assert.strictEqual(m.tokens.measured, 15);
  assert.strictEqual(m.tokens.entries_without_tokens, 1);
});

test('check: outcome型の判定器で裏付けられていない成功基準を警告する', () => {
  const { root, osDir } = makeOs();
  write(root, 'README.md', '# x\n');
  const evaluator = (id, kind) => [
    `id: ${id}`,
    'applies_to: task_artifact',
    'tier: T0',
    ...(kind ? [`kind: ${kind}`] : []),
    'method: deterministic',
    'checks:',
    '  - kind: file_exists',
    '    path: README.md',
  ].join('\n');
  write(osDir, 'evaluators/form_check.yaml', evaluator('form_check', 'conformance'));
  write(osDir, 'evaluators/reader_reaches.yaml', evaluator('reader_reaches', 'outcome'));
  const goal = (ev) => [
    'goal: x',
    'domain: d',
    'objectives: [o]',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: 読者が目的の発見に到達する',
    `    evaluator: ${ev}`,
    'constraints: []',
    'sources:',
    '  - repo: .',
  ].join('\n');
  write(osDir, 'goal.yaml', goal('form_check'));
  const conformanceOnly = schema.checkAll(osDir);
  assert.ok(conformanceOnly.warnings.some((w) => w.includes('sc-001→form_check')), JSON.stringify(conformanceOnly.warnings));
  write(osDir, 'goal.yaml', goal('reader_reaches'));
  assert.ok(!schema.checkAll(osDir).warnings.some((w) => w.includes('sc-001')));
});

test('CLI next-action: DELIVERのcaveatsを出力から落とさない', () => {
  const { root, osDir } = makeOs();
  write(root, 'README.md', '# x\n');
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
    'goal: x',
    'domain: d',
    'objectives: [o]',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: 測れる基準',
    '    evaluator: bound',
    '  - id: sc-002',
    '    statement: 測れていない基準',
    '    evaluator: unbound',
    'constraints: []',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'cli caveats', ['bound']);
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'bound', verdict: 'PASS', evidence: ['e'], provenance: 'deterministic' });
  const cli = path.join(__dirname, '..', 'cli', 'index.js');
  const r = spawnSync(process.execPath, [cli, 'next-action', t.id, '--os-dir', osDir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('action: DELIVER'), r.stdout);
  // コアが返すcaveatsがCLI出力に現れる（ここが落ちるとDONEが「Goalが測れている」と読まれる）
  assert.ok(r.stdout.includes('caveats:'), r.stdout);
  assert.ok(r.stdout.includes('sc-002'), r.stdout);
});
