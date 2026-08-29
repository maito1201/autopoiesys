'use strict';
// タスク類型: 同定（fingerprint）→ 再来の提示（suggestClasses）→ 蒸留の開示強制
// （recordConsolidation）→ 系列の取り出し（classAttempts）。すべて決定的でLLMを呼ばない。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeOs } = require('./helpers');
const { appendJsonl } = require('../core/util');
const evaluate = require('../core/evaluate');
const store = require('../core/store');
const taskclass = require('../core/taskclass');

const CLASS_A = 'parser regression fix';

function newLesson(osDir, body, extra = {}) {
  const r = store.recordStatement(osDir, {
    type: 'lesson',
    body,
    when: '同種の作業のとき',
    source: 'test',
    method: 'deterministic',
    ...extra,
  });
  return r.added[0];
}

test('classFingerprint: 空白と大文字小文字の違いは同じ類型に畳まれる', () => {
  const a = taskclass.classFingerprint('Parser  Regression Fix');
  const b = taskclass.classFingerprint('parser regression fix');
  const c = taskclass.classFingerprint('  parser\nregression fix ');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  // 別の類型は別のfingerprint（言い回しの揺れは吸収しない — 抽象化は書き手の仕事）
  assert.notStrictEqual(a, taskclass.classFingerprint('weekly report writing'));
  // 空は類型にならない
  assert.throws(() => taskclass.classFingerprint('   '), /空でない文字列/);
  assert.throws(() => taskclass.classFingerprint(undefined), /空でない文字列/);
});

test('suggestClasses: 語の重なりで順位づけ、同一fpのタスクは1つの類型にまとまる', () => {
  const { osDir } = makeOs();
  // 表記揺れ（大文字・二重空白）があってもfpが同じなら同じ類型
  const t1 = evaluate.newTask(osDir, 'fix parser regression in tokenizer', [], { class: CLASS_A });
  const t2 = evaluate.newTask(osDir, 'fix parser regression in printer', [], { class: 'Parser  Regression Fix' });
  const t3 = evaluate.newTask(osDir, 'write weekly report about metrics', [], { class: 'weekly report writing' });

  const out = taskclass.suggestClasses(osDir, 'fix regression in the parser');
  // 重なりゼロの類型（weekly report writing）は返さない
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].class, CLASS_A);
  assert.strictEqual(out[0].class_fp, taskclass.classFingerprint(CLASS_A));
  assert.deepStrictEqual(out[0].tasks, [t1.id, t2.id]);
  assert.strictEqual(out[0].score, 3); // fix / regression / parser（theはstop語、inは2文字）
  assert.strictEqual(t3.id, 'T003'); // fixtureの前提確認
});

test('suggestClasses: 過去タスクのobjectiveの語でも重なりを取る（classは抽象で語が薄い）', () => {
  const { osDir } = makeOs();
  evaluate.newTask(osDir, 'investigate tokenizer crash on emoji input', [], { class: CLASS_A });
  // 新objectiveはclass文字列と1語も重ならないが、過去objectiveのtokenizer/emojiで届く
  const out = taskclass.suggestClasses(osDir, 'tokenizer breaks on emoji again');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].class, CLASS_A);
  assert.strictEqual(out[0].score, 2); // tokenizer / emoji
});

test('suggestClasses: 決定性 — 同点はclass名の昇順、再実行で同じ結果', () => {
  const { osDir } = makeOs();
  // 登録順はzzzが先。スコアが同点ならclass名昇順（aaaが先）に並ぶことを見る
  evaluate.newTask(osDir, 'remove dead code from moduleone', [], { class: 'zzz cleanup' });
  evaluate.newTask(osDir, 'remove dead code from moduletwo', [], { class: 'aaa cleanup' });
  const out1 = taskclass.suggestClasses(osDir, 'cleanup of stale branches');
  assert.deepStrictEqual(out1.map((x) => [x.class, x.score]), [['aaa cleanup', 1], ['zzz cleanup', 1]]);
  const out2 = taskclass.suggestClasses(osDir, 'cleanup of stale branches');
  assert.deepStrictEqual(out1, out2);
  // classを持つタスクが無ければ空
  assert.deepStrictEqual(taskclass.suggestClasses(makeOs().osDir, 'anything at all'), []);
});

test('recordConsolidation: 開示の強制 — lessonsもnone_learnedも無い呼び出しはエラー', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, 'some work', [], { class: CLASS_A });
  assert.throws(() => taskclass.recordConsolidation(osDir, t.id, {}), /開示が無い/);
  assert.throws(() => taskclass.recordConsolidation(osDir, t.id, { lessons: [] }), /開示が無い/);
  assert.throws(() => taskclass.recordConsolidation(osDir, t.id, { none_learned: '  ' }), /開示にならない/);
  // 内容は強制しない: 「学びなし」も理由つきなら通る
  const updated = taskclass.recordConsolidation(osDir, t.id, { none_learned: '既知の手順の反復で新規性が無かった' });
  assert.strictEqual(updated.consolidated.none_learned, '既知の手順の反復で新規性が無かった');
  assert.deepStrictEqual(updated.consolidated.lessons, []);
  assert.ok(updated.consolidated.ts);
  // 存在しないタスクには記録できない
  assert.throws(() => taskclass.recordConsolidation(osDir, 'T999', { none_learned: 'x' }), /タスクが存在しない/);
});

test('recordConsolidation: lessons/helped/misledはlessonの実在IDだけを受理する', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, 'some work', [], { class: CLASS_A });
  const l1 = newLesson(osDir, '大きな入力はまず標本で試す');
  const l2 = newLesson(osDir, '結合前にlintを回す');
  const claim = store.recordStatement(osDir, {
    type: 'claim', body: 'lessonではないStatement', source: 'test', method: 'deterministic',
  }).added[0];

  assert.throws(
    () => taskclass.recordConsolidation(osDir, t.id, { lessons: ['S9999'] }),
    /S9999 は現在状態に存在しない/
  );
  assert.throws(
    () => taskclass.recordConsolidation(osDir, t.id, { lessons: [l1], helped: [claim] }),
    /type: claim/
  );
  // 同じlessonが同じタスクで「効いた」かつ「外れた」は矛盾した開示
  assert.throws(
    () => taskclass.recordConsolidation(osDir, t.id, { lessons: [l1], helped: [l2], misled: [l2] }),
    /helpedとmisledに同じID/
  );
  // 「教訓が生まれた」と「学びが無かった」は両立しない
  assert.throws(
    () => taskclass.recordConsolidation(osDir, t.id, { lessons: [l1], none_learned: '無し' }),
    /同時に記録できない/
  );

  const updated = taskclass.recordConsolidation(osDir, t.id, {
    lessons: [l1], helped: [l2], misled: [], note: '2回目の同種タスク',
  });
  assert.deepStrictEqual(updated.consolidated.lessons, [l1]);
  assert.deepStrictEqual(updated.consolidated.helped, [l2]);
  assert.deepStrictEqual(updated.consolidated.misled, []);
  assert.strictEqual(updated.consolidated.note, '2回目の同種タスク');
  // 台帳の最新状態からも見える（会話ではなくOSが正本）
  assert.deepStrictEqual(evaluate.getTask(osDir, t.id).consolidated.lessons, [l1]);
});

test('unconsolidatedDone: doneかつ蒸留未記録のタスクだけが出て、記録すると消える', () => {
  const { osDir } = makeOs();
  const done1 = evaluate.newTask(osDir, 'finished work', [], { class: CLASS_A });
  evaluate.updateTask(osDir, done1.id, { status: 'done' });
  const open1 = evaluate.newTask(osDir, 'ongoing work', []);

  let out = taskclass.unconsolidatedDone(osDir);
  assert.deepStrictEqual(out, [{ id: done1.id, objective: 'finished work', class: CLASS_A }]);
  assert.ok(!out.some((x) => x.id === open1.id), 'openのタスクは出ない');

  taskclass.recordConsolidation(osDir, done1.id, { none_learned: '反復作業で新しい学びは無かった' });
  assert.deepStrictEqual(taskclass.unconsolidatedDone(osDir), []);

  // classを付けずにdoneになったタスクも視界から落ちない（classはnullで出る）
  evaluate.updateTask(osDir, open1.id, { status: 'done' });
  assert.deepStrictEqual(taskclass.unconsolidatedDone(osDir), [
    { id: open1.id, objective: 'ongoing work', class: null },
  ]);
});

test('classAttempts: 試行は作成ts順 — 古い試行を後から更新しても系列の順序は変わらない', () => {
  const { osDir } = makeOs();
  const file = path.join(osDir, 'tasks', 'tasks.jsonl');
  const fpA = taskclass.classFingerprint(CLASS_A);
  const fpB = taskclass.classFingerprint('other thing');
  const base = { status: 'open', artifacts: [], evaluators: [], class: CLASS_A, class_fp: fpA };
  appendJsonl(file, { id: 'T001', ts: '2026-01-01T00:00:00Z', objective: 'attempt one', ...base });
  appendJsonl(file, { id: 'T002', ts: '2026-01-02T00:00:00Z', objective: 'attempt two', ...base });
  appendJsonl(file, {
    id: 'T003', ts: '2026-01-03T00:00:00Z', objective: 'unrelated',
    status: 'open', artifacts: [], evaluators: [], class: 'other thing', class_fp: fpB,
  });
  // T001（1回目の試行）を、T002より後に完了として更新する。マージ後のtsは最終更新時刻に
  // なるが、「何回目の試行か」は着手順で数えるので順序は入れ替わらない
  appendJsonl(file, { id: 'T001', ts: '2026-01-04T00:00:00Z', status: 'done' });

  const out = taskclass.classAttempts(osDir, fpA);
  assert.deepStrictEqual(out.map((t) => t.id), ['T001', 'T002']);
  assert.strictEqual(out[0].status, 'done'); // 状態は最新にマージされている
  assert.strictEqual(out[0].created_ts, '2026-01-01T00:00:00Z');
  assert.strictEqual(out[0].ts, '2026-01-04T00:00:00Z');
  // 別の類型・未知のfpは混ざらない
  assert.deepStrictEqual(taskclass.classAttempts(osDir, fpB).map((t) => t.id), ['T003']);
  assert.deepStrictEqual(taskclass.classAttempts(osDir, 'deadbeef'), []);
});
