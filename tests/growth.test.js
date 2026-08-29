'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeOs } = require('./helpers');
const evaluate = require('../core/evaluate');
const growth = require('../core/growth');
const { appendJsonl } = require('../core/util');

// taskclass.js（並行実装）に依存せず、台帳とログを直接書いて検証する。
// growth.jsは読み取り専用の集計なので、正本ファイルの形だけ合っていればよい。
function addTaskRow(osDir, row) {
  appendJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'), {
    objective: `objective ${row.id}`,
    status: 'open',
    artifacts: [],
    evaluators: [],
    ...row,
  });
}

function addVerdict(osDir, task, verdict, ts) {
  appendJsonl(path.join(osDir, 'evaluations', 'log.jsonl'), {
    ts: ts || '2026-08-01T00:00:00Z',
    task,
    evaluator: 'ev',
    verdict,
    evidence: ['test'],
    rationale: '',
    provenance: 'deterministic',
    tier: 'T0',
    tokens: 0,
  });
}

function addContextRow(osDir, task, tokens, kind = 'briefing') {
  appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
    ts: '2026-08-01T00:00:00Z',
    kind,
    task,
    tokens_est: tokens,
  });
}

test('growthSeries: verdict・トークン・教訓・doneを類型ごとに正しく集計する', () => {
  const { osDir } = makeOs();
  // 実APIで作成→classは台帳更新で付与（classFingerprintの計算はtaskclass担当のため
  // ここでは任意の8桁を指紋として与える）
  const t1 = evaluate.newTask(osDir, 'API調査 1回目', []);
  const t2 = evaluate.newTask(osDir, 'API調査 2回目', []);
  const t3 = evaluate.newTask(osDir, 'バグ修正', []);
  evaluate.updateTask(osDir, t1.id, { class: '外部APIの仕様調査', class_fp: 'aaaa1111' });
  evaluate.updateTask(osDir, t2.id, { class: '外部APIの仕様調査', class_fp: 'aaaa1111' });
  evaluate.updateTask(osDir, t3.id, { class: '再現手順つきバグ修正', class_fp: 'bbbb2222' });

  // t1: FAIL 2 / UNCERTAIN 1 / PASS 1 → verdicts 4。実writerで書く
  evaluate.recordVerdict(osDir, { task: t1.id, evaluator: 'ev', verdict: 'FAIL', evidence: ['x'] });
  evaluate.recordVerdict(osDir, { task: t1.id, evaluator: 'ev', verdict: 'FAIL', evidence: ['x'] });
  evaluate.recordVerdict(osDir, { task: t1.id, evaluator: 'ev', verdict: 'UNCERTAIN', evidence: ['x'] });
  evaluate.recordVerdict(osDir, { task: t1.id, evaluator: 'ev', verdict: 'PASS', evidence: ['x'] });
  // t2: verdictなし

  // トークン: briefingのみ合算。policy_hit等の非briefing行は数えない
  addContextRow(osDir, t1.id, 100);
  addContextRow(osDir, t1.id, 50);
  addContextRow(osDir, t1.id, 0, 'policy_hit');
  addContextRow(osDir, t2.id, 30);
  addContextRow(osDir, t3.id, 999, 'query'); // briefingでない消費は対象外

  // t1: consolidate済み（教訓2件・done）。t2: 未consolidate。t3: 「学びなし」で開示済み
  evaluate.updateTask(osDir, t1.id, { status: 'done', consolidated: { ts: '2026-08-01T00:00:00Z', lessons: ['L001', 'L002'] } });
  evaluate.updateTask(osDir, t3.id, { consolidated: { ts: '2026-08-01T00:00:00Z', lessons: [] } });

  const series = growth.growthSeries(osDir);
  assert.deepStrictEqual(Object.keys(series).sort(), ['aaaa1111', 'bbbb2222']);
  const a = series.aaaa1111;
  assert.strictEqual(a.class, '外部APIの仕様調査');
  assert.strictEqual(a.attempts.length, 2);

  const [att1, att2] = a.attempts;
  assert.strictEqual(att1.task.id, t1.id);
  assert.strictEqual(att1.task.objective, 'API調査 1回目');
  assert.strictEqual(att1.fails, 2);
  assert.strictEqual(att1.uncertains, 1);
  assert.strictEqual(att1.verdicts, 4);
  assert.strictEqual(att1.tokens, 150);
  assert.strictEqual(att1.lessons_produced, 2);
  assert.strictEqual(att1.done, true);

  assert.strictEqual(att2.task.id, t2.id);
  assert.strictEqual(att2.fails, 0);
  assert.strictEqual(att2.verdicts, 0);
  assert.strictEqual(att2.tokens, 30);
  assert.strictEqual(att2.lessons_produced, null); // 未consolidateはnull（0と区別する）
  assert.strictEqual(att2.done, false);

  // 「学びなし」の開示は0（nullではない）
  assert.strictEqual(series.bbbb2222.attempts[0].lessons_produced, 0);
  assert.strictEqual(series.bbbb2222.attempts[0].tokens, 0);
});

test('growthSeries: 試行は作成時刻の昇順（記録順・ID順・更新時刻ではない）', () => {
  const { osDir } = makeOs();
  // T002を先に作成した世界: ファイルにはT001が先に現れるが、作成tsはT002が古い
  addTaskRow(osDir, { id: 'T001', ts: '2026-08-02T00:00:00Z', class: 'x', class_fp: 'cccc3333' });
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-01T00:00:00Z', class: 'x', class_fp: 'cccc3333' });
  // T002を後から更新（最新行のtsはT001より新しくなる）。系列の順序は変わらないこと
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-03T00:00:00Z', class: 'x', class_fp: 'cccc3333', status: 'done' });

  const series = growth.growthSeries(osDir);
  const ids = series.cccc3333.attempts.map((a) => a.task.id);
  assert.deepStrictEqual(ids, ['T002', 'T001']);
  // 更新内容（status: done）は反映され、順序だけが作成時刻に固定される
  assert.strictEqual(series.cccc3333.attempts[0].done, true);
});

test('growthSeries: classを持たないタスクは系列に含めない', () => {
  const { osDir } = makeOs();
  addTaskRow(osDir, { id: 'T001', ts: '2026-08-01T00:00:00Z' });
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-02T00:00:00Z', class: 'y', class_fp: 'dddd4444' });
  const series = growth.growthSeries(osDir);
  assert.deepStrictEqual(Object.keys(series), ['dddd4444']);
  assert.strictEqual(series.dddd4444.attempts.length, 1);
});

test('growthReport: 試行3回未満の類型には但し書きが必ず付く', () => {
  const { osDir } = makeOs();
  addTaskRow(osDir, { id: 'T001', ts: '2026-08-01T00:00:00Z', class: 'API調査', class_fp: 'aaaa1111' });
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-02T00:00:00Z', class: 'API調査', class_fp: 'aaaa1111' });
  addTaskRow(osDir, { id: 'T003', ts: '2026-08-03T00:00:00Z', class: 'バグ調査', class_fp: 'bbbb2222' });

  const lines = growth.growthReport(osDir);
  assert.ok(lines.some((l) => l.includes('試行2回。傾向を語るには足りない')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('試行1回。傾向を語るには足りない')), lines.join('\n'));
});

test('growthReport: 3回以上でも傾向の断定文を出さない（系列を並べるだけ）', () => {
  const { osDir } = makeOs();
  // FAILが3→1→0と減る「成長と言いたくなる」系列を作る
  addTaskRow(osDir, { id: 'T001', ts: '2026-08-01T00:00:00Z', class: 'API調査', class_fp: 'aaaa1111' });
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-02T00:00:00Z', class: 'API調査', class_fp: 'aaaa1111' });
  addTaskRow(osDir, { id: 'T003', ts: '2026-08-03T00:00:00Z', class: 'API調査', class_fp: 'aaaa1111' });
  for (let i = 0; i < 3; i++) addVerdict(osDir, 'T001', 'FAIL');
  addVerdict(osDir, 'T002', 'FAIL');
  addVerdict(osDir, 'T003', 'PASS');

  const lines = growth.growthReport(osDir);
  const text = lines.join('\n');
  // 3回に達したので但し書きは消える
  assert.ok(!text.includes('傾向を語るには足りない'), text);
  // 表の行は3試行ぶん出る
  assert.ok(lines.some((l) => l.startsWith('| 1 | T001 | 3 |')), text);
  assert.ok(lines.some((l) => l.startsWith('| 3 | T003 | 0 |')), text);
  // 断定の語彙が出力に現れない（判断は読み手に渡す）
  for (const banned of ['成長', '改善', '悪化', '向上', '良くなって', '減っている', '増えている']) {
    assert.ok(!text.includes(banned), `断定文が出力に混入: ${banned}\n${text}`);
  }
});

test('growthReport: classQueryは類型名の部分一致で絞る', () => {
  const { osDir } = makeOs();
  addTaskRow(osDir, { id: 'T001', ts: '2026-08-01T00:00:00Z', class: '外部APIの仕様調査', class_fp: 'aaaa1111' });
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-02T00:00:00Z', class: 'バグ修正', class_fp: 'bbbb2222' });

  const lines = growth.growthReport(osDir, 'API');
  const text = lines.join('\n');
  assert.ok(text.includes('外部APIの仕様調査'), text);
  assert.ok(!text.includes('バグ修正'), text);

  const miss = growth.growthReport(osDir, '存在しない類型');
  assert.ok(miss.join('\n').includes('部分一致する類型が無い'), miss.join('\n'));
});

test('worseningClasses: 直近試行のFAILが前回より増えた類型だけを返す', () => {
  const { osDir } = makeOs();
  // A: 1→3（増加＝検出）
  addTaskRow(osDir, { id: 'T001', ts: '2026-08-01T00:00:00Z', class: 'A類型', class_fp: 'aaaa1111' });
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-02T00:00:00Z', class: 'A類型', class_fp: 'aaaa1111' });
  addVerdict(osDir, 'T001', 'FAIL');
  for (let i = 0; i < 3; i++) addVerdict(osDir, 'T002', 'FAIL');
  // B: 2→2（横ばい＝非検出）
  addTaskRow(osDir, { id: 'T003', ts: '2026-08-01T00:00:00Z', class: 'B類型', class_fp: 'bbbb2222' });
  addTaskRow(osDir, { id: 'T004', ts: '2026-08-02T00:00:00Z', class: 'B類型', class_fp: 'bbbb2222' });
  for (const id of ['T003', 'T004']) for (let i = 0; i < 2; i++) addVerdict(osDir, id, 'FAIL');
  // C: 3→1（減少＝非検出）
  addTaskRow(osDir, { id: 'T005', ts: '2026-08-01T00:00:00Z', class: 'C類型', class_fp: 'cccc3333' });
  addTaskRow(osDir, { id: 'T006', ts: '2026-08-02T00:00:00Z', class: 'C類型', class_fp: 'cccc3333' });
  for (let i = 0; i < 3; i++) addVerdict(osDir, 'T005', 'FAIL');
  addVerdict(osDir, 'T006', 'FAIL');
  // D: 試行1回（比較不能＝非検出。FAILが多くても対象外）
  addTaskRow(osDir, { id: 'T007', ts: '2026-08-01T00:00:00Z', class: 'D類型', class_fp: 'dddd4444' });
  for (let i = 0; i < 5; i++) addVerdict(osDir, 'T007', 'FAIL');

  const out = growth.worseningClasses(osDir);
  assert.deepStrictEqual(out, [
    { class: 'A類型', class_fp: 'aaaa1111', last_fails: 3, prev_fails: 1 },
  ]);
});

test('worseningClasses: UNCERTAINの増加はFAILとして数えない', () => {
  const { osDir } = makeOs();
  // FAILは0→0のまま、UNCERTAINだけ増える → 検出しない
  addTaskRow(osDir, { id: 'T001', ts: '2026-08-01T00:00:00Z', class: 'E類型', class_fp: 'eeee5555' });
  addTaskRow(osDir, { id: 'T002', ts: '2026-08-02T00:00:00Z', class: 'E類型', class_fp: 'eeee5555' });
  addVerdict(osDir, 'T001', 'PASS');
  for (let i = 0; i < 3; i++) addVerdict(osDir, 'T002', 'UNCERTAIN');
  assert.deepStrictEqual(growth.worseningClasses(osDir), []);
});
