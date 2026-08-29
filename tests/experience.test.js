'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs } = require('./helpers');
const experience = require('../core/experience');
const store = require('../core/store');
const policy = require('../core/policy');
const decision = require('../core/decision');
const failure = require('../core/failure');
const evaluate = require('../core/evaluate');

// 類型fingerprint。taskclass.jsのclassFingerprintはoptionsなしのsituationFingerprintと
// 同じ正規化なので、テストではこちらを直接使う（並行実装への依存を作らない）。
const CLASS = 'apiの障害を切り分けて対処する';
const CLASS_FP = policy.situationFingerprint(CLASS);

// class_fp付きタスクを台帳に作る。newTaskの--class経路はtaskclass.jsに依存するため、
// テストではclass無しで作ってからpatchで付ける（正本はtasks.jsonlの最新行）。
function makeClassedTask(osDir, objective, patch = {}) {
  const t = evaluate.newTask(osDir, objective, []);
  return evaluate.updateTask(osDir, t.id, { class: CLASS, class_fp: CLASS_FP, ...patch });
}

test('recordLesson: lesson型Statementとしてwhen/task_class/provenanceつきで記録される', () => {
  const { osDir } = makeOs();
  const r = experience.recordLesson(osDir, 'timeoutはretryの前にbackoff設定を疑え', {
    when: 'apiがtimeoutで落ちたとき',
    task_class: CLASS_FP,
    tags: ['api'],
    scope: ['repoA'],
    origin_task: 'T001',
    origin_failure: 'F001',
    source: 'consolidate',
  });
  assert.match(r.id, /^S\d{4}$/);
  const st = store.getSnapshot(osDir).statements[r.id];
  assert.strictEqual(st.type, 'lesson');
  assert.strictEqual(st.status, 'fact');
  assert.strictEqual(st.when, 'apiがtimeoutで落ちたとき');
  assert.strictEqual(st.task_class, CLASS_FP);
  assert.strictEqual(st.provenance.task, 'T001');
  assert.strictEqual(st.provenance.ref, 'F001');
  assert.strictEqual(st.provenance.source, 'consolidate');
});

test('recordLesson: 空のbody・不正なwhenは書き込まれない', () => {
  const { osDir } = makeOs();
  assert.throws(() => experience.recordLesson(osDir, ''), /bodyが必要/);
  assert.throws(() => experience.recordLesson(osDir, '   '), /bodyが必要/);
  // whenの形式検証はstore側に一元化されている（空文字列は落ちる）
  assert.throws(() => experience.recordLesson(osDir, 'x', { when: '  ' }), /whenは空でない文字列/);
  assert.strictEqual(store.loadEvents(osDir).length, 0);
});

test('lessonsForの順位づけ: 類型一致+5 / scope一致+2 / 語一致+1×最大3', () => {
  const { osDir } = makeOs();
  const byClass = experience.recordLesson(osDir, 'まずログの時刻を揃えろ', { task_class: CLASS_FP });
  const byTerms = experience.recordLesson(osDir, 'retry backoff timeout jitter を順に疑え', {});
  const byScope = experience.recordLesson(osDir, '全く別の話', { scope: ['repoA'] });
  experience.recordLesson(osDir, '何にも一致しない教訓', {});

  const r = experience.lessonsFor(osDir, {
    classFp: CLASS_FP,
    terms: ['retry', 'backoff', 'timeout', 'jitter'], // 4語一致しても上限3
    scope: ['repoA'],
  });
  assert.deepStrictEqual(r.lessons.map((l) => l.id), [byClass.id, byTerms.id, byScope.id]);
  assert.deepStrictEqual(r.lessons.map((l) => l.score), [5, 3, 2]);
  assert.deepStrictEqual(r.excluded, []);
  // 一致ゼロの教訓は返らない（4件目）
  assert.strictEqual(r.lessons.length, 3);
});

test('feedback: 極性リンク（supports/counters）つきevidenceが書かれる', () => {
  const { osDir } = makeOs();
  const a = experience.recordLesson(osDir, '効いた教訓', { task_class: CLASS_FP });
  const b = experience.recordLesson(osDir, '外れた教訓', { task_class: CLASS_FP });
  const r = experience.feedback(osDir, { helped: [a.id], misled: [b.id], task: 'T001' });
  assert.strictEqual(r.added.length, 2);
  const snap = store.getSnapshot(osDir);
  const sup = snap.statements[r.added[0]];
  assert.strictEqual(sup.type, 'evidence');
  assert.deepStrictEqual(sup.links, [{ role: 'supports', to: a.id }]);
  assert.match(sup.body, /タスクT001でこの教訓が有効だった/);
  assert.strictEqual(sup.provenance.task, 'T001');
  const cnt = snap.statements[r.added[1]];
  assert.deepStrictEqual(cnt.links, [{ role: 'counters', to: b.id }]);
  assert.match(cnt.body, /タスクT001でこの教訓が誤誘導した/);
});

test('feedback: lesson型以外・存在しないID・極性の矛盾はエラーで、何も書かれない', () => {
  const { osDir } = makeOs();
  const claim = store.recordStatement(osDir, { body: 'ただの主張', type: 'claim', source: 'test' });
  const lesson = experience.recordLesson(osDir, '教訓', {});
  const before = store.loadEvents(osDir).length;
  assert.throws(
    () => experience.feedback(osDir, { helped: [claim.added[0]], task: 'T001' }),
    /type: lessonではない/
  );
  assert.throws(() => experience.feedback(osDir, { misled: ['S9999'], task: 'T001' }), /存在しない/);
  assert.throws(
    () => experience.feedback(osDir, { helped: [lesson.id], misled: [lesson.id], task: 'T001' }),
    /極性が矛盾/
  );
  assert.throws(() => experience.feedback(osDir, { helped: [lesson.id] }), /taskが必要/);
  assert.strictEqual(store.loadEvents(osDir).length, before);
});

test('helped/misledの実績数が正しく付く（書き戻し→想起の往復）', () => {
  const { osDir } = makeOs();
  const l = experience.recordLesson(osDir, '教訓X', { task_class: CLASS_FP });
  experience.feedback(osDir, { helped: [l.id], task: 'T001' });
  experience.feedback(osDir, { helped: [l.id], task: 'T002' });
  experience.feedback(osDir, { misled: [l.id], task: 'T003' });
  const r = experience.lessonsFor(osDir, { classFp: CLASS_FP });
  assert.strictEqual(r.lessons.length, 1);
  assert.strictEqual(r.lessons[0].helped, 2);
  assert.strictEqual(r.lessons[0].misled, 1);
  // helped >= misled のうちは想起に残る（counters優位になった時点で外れる）
  assert.deepStrictEqual(r.excluded, []);
});

test('反証された教訓（counters > supports）は想起から外れ、excludedに理由つきで出る', () => {
  const { osDir } = makeOs();
  const good = experience.recordLesson(osDir, '生きている教訓', { task_class: CLASS_FP });
  const bad = experience.recordLesson(osDir, '反証された教訓', { task_class: CLASS_FP });
  experience.feedback(osDir, { helped: [good.id], misled: [bad.id], task: 'T001' });
  experience.feedback(osDir, { helped: [bad.id], task: 'T002' });
  experience.feedback(osDir, { misled: [bad.id], task: 'T003' });
  const r = experience.lessonsFor(osDir, { classFp: CLASS_FP });
  assert.deepStrictEqual(r.lessons.map((l) => l.id), [good.id]);
  assert.strictEqual(r.excluded.length, 1);
  assert.strictEqual(r.excluded[0].id, bad.id);
  assert.match(r.excluded[0].why, /外れ2回 > 効き1回/);
});

test('digest: 初回の類型では想起は空で、教訓を残せと言う', () => {
  const { osDir } = makeOs();
  const d = experience.digest(osDir, {
    id: 'T001',
    objective: 'apiの障害を切り分けてretryの方針を決める',
    class: CLASS,
    class_fp: CLASS_FP,
    repo_dirs: {},
  });
  assert.match(d.lines[0], /^## この仕事に効く過去の経験/);
  assert.ok(d.lines.some((l) => l.includes('この類型は初回。終わったら教訓を残せ')));
  assert.deepStrictEqual(d.lessons, []);
  assert.deepStrictEqual(d.past_tasks, []);
  assert.deepStrictEqual(d.policies, []);
  assert.deepStrictEqual(d.failures, []);
  assert.deepStrictEqual(d.unknowns, []);
  assert.ok(d.tokens_est > 0);
});

test('digest: 再来時に過去の同類型タスクと教訓が実績数つきで黙って届く', () => {
  const { osDir } = makeOs();
  const lesson = experience.recordLesson(osDir, 'timeoutはbackoff設定を先に疑え', {
    when: 'apiがtimeoutで落ちたとき',
    task_class: CLASS_FP,
  });
  const past = makeClassedTask(osDir, 'apiの障害を切り分ける（1回目）', {
    status: 'done',
    consolidated: { lessons: [lesson.id] },
  });
  experience.feedback(osDir, { helped: [lesson.id], task: past.id });
  // 類型が違うタスクは届かない
  evaluate.updateTask(osDir, evaluate.newTask(osDir, '無関係なビルド高速化', []).id, {
    class: '別類型', class_fp: policy.situationFingerprint('別類型'),
  });

  const d = experience.digest(osDir, {
    id: 'T999',
    objective: 'apiの障害を切り分けてretryの方針を決める',
    class: CLASS,
    class_fp: CLASS_FP,
    repo_dirs: {},
  });
  assert.deepStrictEqual(d.past_tasks, [
    { id: past.id, objective: 'apiの障害を切り分ける（1回目）', status: 'done', lessons: [lesson.id] },
  ]);
  assert.strictEqual(d.lessons.length, 1);
  assert.strictEqual(d.lessons[0].id, lesson.id);
  const text = d.lines.join('\n');
  assert.match(text, /効いた1回\/外れた0回/);
  assert.match(text, /適用条件: apiがtimeoutで落ちたとき/);
  assert.ok(!text.includes('この類型は初回'));
});

test('digest: 反証された教訓は本文が届かず、除外の事実だけが見える', () => {
  const { osDir } = makeOs();
  const bad = experience.recordLesson(osDir, '常にretryを3回に増やせ', { task_class: CLASS_FP });
  experience.feedback(osDir, { misled: [bad.id], task: 'T001' });
  const d = experience.digest(osDir, {
    id: 'T002', objective: 'apiの障害を切り分ける', class: CLASS, class_fp: CLASS_FP, repo_dirs: {},
  });
  assert.deepStrictEqual(d.lessons, []);
  assert.strictEqual(d.excluded.length, 1);
  const text = d.lines.join('\n');
  assert.ok(!text.includes('常にretryを3回に増やせ'));
  assert.ok(text.includes(`反証された教訓1件（${bad.id}）は想起から外した`));
});

test('digest: 方針・未消化Failure・Unknownが語の重なりで届く', () => {
  const { osDir } = makeOs();
  // 方針: 同じ判断の場で2回metになると自動でコンパイルされる（policy.jsの実経路を使う）
  const mk = () => decision.newDecision(osDir, 'apiの一次対応はロールバックを選ぶ', {
    situation: 'apiの障害の一次対応を選ぶ',
    options: ['rollback', 'hotfix'],
    chosen: 'rollback',
    source: 'test',
  });
  const d1 = mk();
  mk();
  decision.recordOutcome(osDir, d1.id, { result: 'met' });
  // 未消化のFailure（症状が語と重なる）と、重ならないFailure
  const f = failure.report(osDir, { symptom: 'apiのretryが暴走して障害が長引いた' });
  failure.report(osDir, { symptom: 'ビルドキャッシュが壊れていた' });
  // 構造を持つUnknown（blocks/importance）
  const u = store.assertStatements(osDir, [{
    type: 'unknown', body: 'timeoutの妥当な閾値が不明', status: 'unknown',
    blocks: ['sc-001'], importance: 0.8,
    provenance: { source: 'test', method: 'human' },
  }]);

  const d = experience.digest(osDir, {
    id: 'T001',
    objective: 'apiの障害を切り分けてretryとtimeoutの方針を決める',
    class: CLASS,
    class_fp: CLASS_FP,
    repo_dirs: {},
  });
  assert.strictEqual(d.policies.length, 1);
  assert.strictEqual(d.policies[0].choose, 'rollback');
  assert.deepStrictEqual(d.failures.map((x) => x.id), [f.entry.id]);
  assert.deepStrictEqual(d.unknowns.map((x) => x.id), [u.added[0]]);
  const text = d.lines.join('\n');
  assert.match(text, /rollback/);
  assert.match(text, /retryが暴走/);
  assert.match(text, /timeoutの妥当な閾値が不明/);
});
