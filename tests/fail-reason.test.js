'use strict';
// F005 A-1: command evaluatorの fail_reason 宣言。
// insufficient_sampleのFAILは「直せ（FIX）」ではなく「入力を集めよ（COLLECT_EVIDENCE）」へ写る。
const { test } = require('node:test');
const assert = require('node:assert');
const { makeOs, write } = require('./helpers');
const evaluate = require('../core/evaluate');
const failure = require('../core/failure');

test('fail_reason: insufficient_sample のcommand FAILは COLLECT_EVIDENCE へ写る', () => {
  const { root, osDir } = makeOs();
  write(root, 'always-fail.js', 'process.exit(1);\n');
  write(osDir, 'evaluators/underpowered.yaml', [
    'id: underpowered',
    'applies_to: repo_change',
    'tier: T0',
    'method: command',
    'argv: [node, always-fail.js]',
    'expect_exit: 0',
    'fail_reason: insufficient_sample',
  ].join('\n'));
  const t = evaluate.newTask(osDir, '基質不足の検査', ['underpowered']);
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(results[0].verdict, 'FAIL');
  assert.strictEqual(results[0].reason, 'insufficient_sample');
  const r = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(r.action, 'COLLECT_EVIDENCE');
  assert.ok(r.why.includes('検出力不足'));
});

test('fail_reasonが不正な値なら黙って無視される（FAILはFIXのまま）', () => {
  const { root, osDir } = makeOs();
  write(root, 'always-fail.js', 'process.exit(1);\n');
  write(osDir, 'evaluators/badreason.yaml', [
    'id: badreason',
    'applies_to: repo_change',
    'tier: T0',
    'method: command',
    'argv: [node, always-fail.js]',
    'expect_exit: 0',
    'fail_reason: not_a_reason',
  ].join('\n'));
  const t = evaluate.newTask(osDir, '不正reason', ['badreason']);
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.strictEqual(results[0].verdict, 'FAIL');
  assert.strictEqual(results[0].reason, undefined);
  assert.strictEqual(evaluate.nextAction(osDir, t.id).action, 'FIX');
});

test('originはtask newで記録され、OS由来は台帳に解決されてorigin_verifiedが付く', () => {
  const { osDir } = makeOs();
  const f = failure.report(osDir, { symptom: '実在する症状', severity: 'low' }).entry;
  const t = evaluate.newTask(osDir, 'origin付き', [], { origin: `failure:${f.id}` });
  const saved = evaluate.getTask(osDir, t.id);
  assert.strictEqual(saved.origin, `failure:${f.id}`);
  assert.strictEqual(saved.origin_verified.ref, f.id);
  assert.strictEqual(saved.origin_verified.kind, 'failure');
});

// 接頭辞つきの文字列は誰でも打てる。解決できない由来を通すと、自発的推進（sc-007）の
// 証拠が「文字列を打った」だけになる
test('解決できないOS由来はtask newが登録時に失敗する', () => {
  const { osDir } = makeOs();
  assert.throws(
    () => evaluate.newTask(osDir, '実在しない由来', [], { origin: 'failure:F999' }),
    /由来を解決できない/
  );
  assert.throws(
    () => evaluate.newTask(osDir, '実在しない由来', [], { origin: 'lesson:S9999' }),
    /由来を解決できない/
  );
  assert.throws(
    () => evaluate.newTask(osDir, '種別が不明', [], { origin: 'なんとなく' }),
    /未知の由来種別/
  );
});

// userは台帳に無い。照合の対象ではないが、自発的推進の証拠にもならない
test('origin: user は解決を要求されず、origin_verifiedも付かない', () => {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, 'ユーザー指示', [], { origin: 'user' });
  const saved = evaluate.getTask(osDir, t.id);
  assert.strictEqual(saved.origin, 'user');
  assert.strictEqual(saved.origin_verified, undefined);
});
