'use strict';
// 計画の目的適合を、作り始める前に判定させる（F014の是正）。
// 完成物への判定は、不適合が出た時点で実装と判定に費やしたものを取り戻さない。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write } = require('./helpers');
const evaluate = require('../core/evaluate');
const plan = require('../core/plan');
const { preparePlanReview } = require('../core/planreview');

function setup() {
  const { root, osDir } = makeOs();
  const t = evaluate.newTask(osDir, '何かを作る', ['plan_alignment']);
  write(root, 'PLAN.md', [
    '# 計画',
    '## 受け入れ条件',
    '1. 目次生成器を作る',
  ].join('\n'));
  const r = plan.registerPlan(osDir, t.id, 'PLAN.md');
  const abs = plan.resolvePlanPath(osDir, evaluate.getTask(osDir, t.id), 'PLAN.md');
  return { root, osDir, task: evaluate.getTask(osDir, t.id), abs, rel: r.path };
}

test('planreview: 目的と計画本文だけを渡し、実行者の説明は含めない', () => {
  const { osDir, task, abs, rel } = setup();
  const { file } = preparePlanReview(osDir, task, abs, rel);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## 記録された目的（goal\.yaml/);
  assert.match(text, /目次生成器を作る/, '計画本文が入る');
  assert.match(text, /この計画はまだ実行されていない/);
  assert.ok(!text.includes('完了報告'), '完成物の報告は判定材料に入れない');
});

// rubricの正本は evaluator 定義。briefing側にも文面を持つと、片方だけ直した瞬間に
// 判定基準が2つある状態になる（検証装置が検証対象の複製を持つのと同じ形の欠陥）。
test('planreview: rubricは evaluator 定義から引く（文面を二重に持たない）', () => {
  const { osDir, task, abs, rel } = setup();
  write(osDir, 'evaluators/plan_alignment.yaml', [
    'id: plan_alignment', 'applies_to: task_artifact', 'tier: T1', 'method: llm_judge',
    'rubric: |', '  正本にだけ書かれた判定基準',
  ].join('\n'));
  const text = fs.readFileSync(preparePlanReview(osDir, task, abs, rel).file, 'utf8');
  assert.match(text, /正本にだけ書かれた判定基準/);
});

test('planreview: 判定基準を読めないときは、判定させずUNCERTAINを指示する', () => {
  const { osDir, task, abs, rel } = setup();
  const text = fs.readFileSync(preparePlanReview(osDir, task, abs, rel).file, 'utf8');
  assert.match(text, /定義を読めなかった/);
  assert.match(text, /UNCERTAIN/);
});

test('planreview: 確立済みの方針が無いときは「無い」と書く', () => {
  const { osDir, task, abs, rel } = setup();
  const text = fs.readFileSync(preparePlanReview(osDir, task, abs, rel).file, 'utf8');
  assert.match(text, /確立済みの方針は無い/);
});

test('planreview: 生成をcontext_logに機械記録する', () => {
  const { osDir, task, abs, rel } = setup();
  preparePlanReview(osDir, task, abs, rel);
  const rows = fs.readFileSync(path.join(osDir, 'observations', 'context_log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.filter((r) => r.kind === 'plan_review_briefing').pop();
  assert.strictEqual(row.task, task.id);
  assert.ok(row.tokens_est > 0);
});
