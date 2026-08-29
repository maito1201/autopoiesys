'use strict';
// llm_judge に文書だけを渡すと、判定者は「作業そのもの」ではなく
// 「作業についての文章」を読むことになり、実装の欠陥はどの評価器も検出できない。
// この穴をコアが可視化することを検証する。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeOs, write } = require('./helpers');
const evaluate = require('../core/evaluate');
const regression = require('../core/regression');

// CLI の `task artifact` と同じ更新をテストから行う
function addArtifact(osDir, id, p, note) {
  const t = evaluate.getTask(osDir, id);
  const artifacts = [...(t.artifacts || []), { path: p, note: note || '' }];
  evaluate.updateTask(osDir, id, { artifacts });
}

function judgeEvaluator(osDir, id) {
  write(osDir, `evaluators/${id}.yaml`, [
    `id: ${id}`,
    'applies_to: task_artifact',
    'tier: T2',
    'kind: conformance',
    'method: llm_judge',
    'rubric: |',
    '  実装が主張どおりかを判定する。',
  ].join('\n'));
}

test('artifactsIncludeImplementation: 文書だけならfalse、ソースを含めばtrue', () => {
  const { root, osDir } = makeOs();
  write(root, 'report/summary.md', '# 報告\n');
  write(root, 'research/study/run.py', 'print(1)\n');

  const docsOnly = { artifacts: [{ path: 'report/summary.md' }] };
  assert.strictEqual(evaluate.artifactsIncludeImplementation(osDir, docsOnly), false);

  const withFile = { artifacts: [{ path: 'research/study/run.py' }] };
  assert.strictEqual(evaluate.artifactsIncludeImplementation(osDir, withFile), true);

  // ディレクトリを渡した場合は中を見る（相対パスは .os の親から解決する）
  const withDir = { artifacts: [{ path: 'research/study' }] };
  assert.strictEqual(evaluate.artifactsIncludeImplementation(osDir, withDir), true);

  // 実装を含まないディレクトリは false
  write(root, 'docs/a.md', 'a\n');
  const docDir = { artifacts: [{ path: 'docs' }] };
  assert.strictEqual(evaluate.artifactsIncludeImplementation(osDir, docDir), false);
});

test('briefing: 実装が無いときはUNCERTAINを指示し、あるときはコードで確かめよと指示する', () => {
  const { root, osDir } = makeOs();
  write(root, 'report/summary.md', '# 報告\n');
  write(root, 'src/run.py', 'print(1)\n');
  judgeEvaluator(osDir, 'impl_judge');
  const def = evaluate.loadEvaluatorDef(osDir, 'impl_judge');

  const proseTask = { id: 'T001', objective: 'x', artifacts: [{ path: 'report/summary.md' }] };
  const f1 = evaluate.prepareLlmJudge(osDir, def, { task: proseTask });
  const b1 = fs.readFileSync(f1, 'utf8');
  assert.ok(b1.includes('実装（ソースコード）が含まれていない'), b1);
  assert.ok(b1.includes('UNCERTAIN'), b1);

  const codeTask = {
    id: 'T002',
    objective: 'x',
    artifacts: [{ path: 'report/summary.md' }, { path: 'src/run.py' }],
  };
  const f2 = evaluate.prepareLlmJudge(osDir, def, { task: codeTask });
  const b2 = fs.readFileSync(f2, 'utf8');
  assert.ok(b2.includes('実装が含まれる'), b2);
  assert.ok(b2.includes('実物のコードで確かめること'), b2);
  assert.ok(!b2.includes('実装（ソースコード）が含まれていない'), b2);
});

test('maintenanceHints: 文書だけをllm_judgeに渡している開いたタスクを警告する', () => {
  const { root, osDir } = makeOs();
  write(root, 'report/summary.md', '# 報告\n');
  write(root, 'src/run.py', 'print(1)\n');
  judgeEvaluator(osDir, 'impl_judge');

  const prose = evaluate.newTask(osDir, '文書だけ', ['impl_judge']);
  addArtifact(osDir, prose.id, 'report/summary.md', '報告');
  const hints = regression.maintenanceHints(osDir);
  const hit = hints.filter((h) => h.includes('実装（ソースコード）が1件も無い'));
  assert.strictEqual(hit.length, 1, hints.join('\n'));
  assert.ok(hit[0].includes(prose.id), hit[0]);
  assert.ok(hit[0].includes('impl_judge'), hit[0]);

  // 実装をartifactに足すと警告は消える
  addArtifact(osDir, prose.id, 'src/run.py', '実装');
  const after = regression.maintenanceHints(osDir);
  assert.strictEqual(after.filter((h) => h.includes('実装（ソースコード）が1件も無い')).length, 0,
    after.join('\n'));
});

test('maintenanceHints: llm_judgeを持たないタスクは警告しない', () => {
  const { root, osDir } = makeOs();
  write(root, 'report/summary.md', '# 報告\n');
  write(osDir, 'evaluators/t0.yaml', [
    'id: t0',
    'applies_to: repo_change',
    'tier: T0',
    'kind: conformance',
    'method: deterministic',
    'checks:',
    '  - kind: file_exists',
    '    path: report/summary.md',
  ].join('\n'));
  const t = evaluate.newTask(osDir, '決定的評価だけ', ['t0']);
  addArtifact(osDir, t.id, 'report/summary.md', '報告');
  const hints = regression.maintenanceHints(osDir);
  assert.strictEqual(hints.filter((h) => h.includes('実装（ソースコード）が1件も無い')).length, 0,
    hints.join('\n'));
});
