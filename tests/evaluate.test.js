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

// --- 判定サブエージェントのコスト（T017）: 独立性を落とさずに無駄な判定を減らす
function makeJudgeOs() {
  const { osDir } = makeOs();
  write(osDir, 'evaluators/judge.yaml', [
    'id: judge',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'rubric: |',
    '  要件を満たしているか判定せよ。',
  ].join('\n'));
  return osDir;
}

test('llm_judge: 前回の判定以降に成果物が変わっていなければ再判定しない', () => {
  const osDir = makeJudgeOs();
  const t = evaluate.newTask(osDir, 'judge対象', ['judge']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-08-01T00:00:00Z' });
  // 1回目: briefingが作られる
  assert.strictEqual(evaluate.evaluateTask(osDir, t.id).results[0].pending, true);
  evaluate.recordVerdict(osDir, {
    task: t.id, evaluator: 'judge', verdict: 'PASS', evidence: ['読んだ'], provenance: 'llm',
  });
  // 2回目: 成果物が変わっていないので生成しない（判定1本のコストがまるごと無駄になるため）
  const again = evaluate.evaluateTask(osDir, t.id).results[0];
  assert.strictEqual(again.pending, false);
  assert.strictEqual(again.skipped, 'unchanged');
  assert.ok(again.why.includes('変わっていない'));
  assert.ok(!again.briefing);
  // 成果物を登録すれば再び生成される（直したら判定し直す経路は塞がない）
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '指摘を直した', ts: '2099-01-01T00:00:00Z' });
  assert.strictEqual(evaluate.evaluateTask(osDir, t.id).results[0].pending, true);
});

test('llm_judge: briefingのArtifactはパスごとに1行で、前回の判定以降の変更に印が付く', () => {
  const osDir = makeJudgeOs();
  const t = evaluate.newTask(osDir, 'judge対象', ['judge']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '1回目', ts: '2026-08-01T00:00:00Z' });
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '2回目', ts: '2026-08-02T00:00:00Z' });
  evaluate.addArtifact(osDir, t.id, { path: 'src/b.js', note: '実装', ts: '2026-08-02T00:00:00Z' });
  evaluate.evaluateTask(osDir, t.id);
  evaluate.recordVerdict(osDir, {
    task: t.id, evaluator: 'judge', verdict: 'FAIL', evidence: ['欠陥'], provenance: 'llm',
  });
  evaluate.addArtifact(osDir, t.id, { path: 'src/c.js', note: '指摘への修正', ts: '2099-01-01T00:00:00Z' });
  const briefing = fs.readFileSync(evaluate.evaluateTask(osDir, t.id).results[0].briefing, 'utf8');
  const lines = briefing.split('\n').filter((l) => /^- (★ )?src\//.test(l));
  assert.deepStrictEqual(lines.map((l) => l.replace(/ —.*$/, '')), [
    '- src/a.js', '- src/b.js', '- ★ src/c.js',
  ], briefing);
  // 同じパスは最新の登録だけが残る（登録の履歴を読ませない）
  assert.ok(briefing.includes('2回目'));
  assert.ok(!briefing.includes('1回目'));
  assert.ok(briefing.includes('それ以降に変わったのは 1 件'));
});

test('llm_judge: 保留の結果に、evaluatorのtierとrouting表から引いたモデルが付く', () => {
  const osDir = makeJudgeOs();
  const t = evaluate.newTask(osDir, 'judge対象', ['judge']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-08-01T00:00:00Z' });
  const r = evaluate.evaluateTask(osDir, t.id).results[0];
  assert.strictEqual(r.tier, 'T2');
  assert.strictEqual(r.model, 'mid', 'config.yamlのrouting表 T2.model を引くこと');
});

test('llm_judge: 検証実績はevaluatorごとに最新1件に畳み、過去は推移1行に残す', () => {
  const osDir = makeJudgeOs();
  const t = evaluate.newTask(osDir, 'judge対象', ['judge']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-08-01T00:00:00Z' });
  // 別のevaluatorが3回判定した履歴（全履歴を載せるとevaluateのたびにbriefingが膨れ続ける。
  // 実測: 6回evaluateしたタスクでこの節が3,951トークン=briefing全体の66%を占めた）
  for (const [verdict, ev] of [['PASS', '1回目の証拠'], ['FAIL', '2回目の証拠'], ['PASS', '3回目の証拠']]) {
    evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'checks', verdict, evidence: [ev], provenance: 'deterministic' });
  }
  // 判定中のevaluator自身の過去verdictは自己参照になるため載せない
  evaluate.recordVerdict(osDir, { task: t.id, evaluator: 'judge', verdict: 'FAIL', evidence: ['judge自身の過去判定'], provenance: 'llm' });
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const briefing = fs.readFileSync(evaluate.prepareLlmJudge(osDir, def, { task: evaluate.getTask(osDir, t.id) }), 'utf8');
  assert.ok(briefing.includes('3回目の証拠'), '最新のevidenceは載る');
  assert.ok(!briefing.includes('1回目の証拠') && !briefing.includes('2回目の証拠'), '過去のevidenceは載せない');
  assert.ok(briefing.includes('これまでの推移（3回）: PASS → FAIL → PASS'), '判定が動いた事実は1行で残す');
  assert.ok(!briefing.includes('judge自身の過去判定'), '判定中のevaluator自身は除く');
});

test('llm_judge: 再判定を止めたら、止めた事実を台帳に残す（節約の実測とスキップ経路の裏づけ）', () => {
  const osDir = makeJudgeOs();
  const t = evaluate.newTask(osDir, 'judge対象', ['judge']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-08-01T00:00:00Z' });
  evaluate.evaluateTask(osDir, t.id);
  evaluate.recordVerdict(osDir, {
    task: t.id, evaluator: 'judge', verdict: 'PASS', evidence: ['読んだ'], provenance: 'llm',
  });
  evaluate.evaluateTask(osDir, t.id); // 同一状態 → スキップ
  const rows = fs.readFileSync(require('node:path').join(osDir, 'observations', 'context_log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const skipped = rows.filter((r) => r.kind === 'briefing_skipped');
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].evaluator, 'judge');
  assert.strictEqual(skipped[0].task, t.id);
  assert.ok(skipped[0].since, '何の状態以降で止めたかを残す');
  // briefing本体は生成されない（記録が増えても判定の探索は走らない）
  assert.strictEqual(rows.filter((r) => r.kind === 'briefing').length, 1);
});

// 信用の境界（T021）: 決定的記録は事実として信用してよいが、その記録が
// 「いつの状態への検査か」は機械が判定して見せる。ここが退行すると、判定者は
// 古い記録を現在の状態への保証として読む（＝古い判定でDONEに到達する穴と同じ形）。
test('briefing: 検証実績の各行に鮮度が付き、成果物より古い記録は「古い」と明示される', () => {
  const osDir = makeJudgeOs();
  const t = evaluate.newTask(osDir, 'judge対象', ['judge']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-08-01T00:00:00Z' });
  // 成果物より後に記録された検査（＝現在の状態を見ている）
  evaluate.recordVerdict(osDir, {
    task: t.id, evaluator: 'checks', verdict: 'PASS', evidence: ['exit=0'], provenance: 'deterministic',
  });
  const def = evaluate.loadEvaluatorDef(osDir, 'judge');
  const fresh = fs.readFileSync(evaluate.prepareLlmJudge(osDir, def, { task: evaluate.getTask(osDir, t.id) }), 'utf8');
  assert.match(fresh, /checks: PASS（provenance=deterministic, .*現在の成果物への検査）/);
  assert.match(fresh, /信用の境界/);
  assert.match(fresh, /その時刻の状態のことしか語らない/);

  // 記録の後に成果物が変わったら「古い」に変わる
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '修正', ts: '2099-01-01T00:00:00Z' });
  const stale = fs.readFileSync(evaluate.prepareLlmJudge(osDir, def, { task: evaluate.getTask(osDir, t.id) }), 'utf8');
  assert.match(stale, /checks: PASS（provenance=deterministic, .*\*\*古い\*\*（この記録の後に成果物が変わっている: 2099-01-01/);
});

// 決定的な検査を先に全部走らせてからbriefingを組む（T021の実測から）。
// 宣言順のまま回すと、判定者に渡る検証実績は「このrunより前の記録」になり、
// 鮮度ラベルが全行「古い」になって判定者は全検査を自分で回し直す。
test('evaluate: llm_judgeのbriefingは、同じrunの決定的検査の結果を載せる', () => {
  const osDir = makeJudgeOs();
  // judgeを決定的検査より**前**に宣言する（宣言順に回すと古い記録が載る配置）
  write(osDir, 'evaluators/always_pass.yaml', [
    'id: always_pass', 'applies_to: repo_change', 'tier: T0', 'method: deterministic',
    'checks:', '  - kind: query_empty', '    query: get_constraints',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'judge対象', ['judge', 'always_pass']);
  evaluate.addArtifact(osDir, t.id, { path: 'src/a.js', note: '実装', ts: '2026-08-01T00:00:00Z' });
  const r = evaluate.evaluateTask(osDir, t.id);
  const briefing = fs.readFileSync(r.results.find((x) => x.evaluator === 'judge').briefing, 'utf8');
  // 同じrunで走ったalways_passの記録がbriefingに載り、かつ「古い」ではない
  assert.match(briefing, /always_pass: (PASS|FAIL|UNCERTAIN)/, briefing.slice(0, 400));
  assert.ok(!/always_pass: .*\*\*古い\*\*/.test(briefing), '同じrunの記録が古い扱いになってはならない');
});
