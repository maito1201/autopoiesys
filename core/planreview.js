'use strict';
// 計画の目的適合を、**作り始める前に**判定させるためのbriefing（F014）。
//
// 既存の目的適合判定（objective_alignment）は完成物に対して走る。そこで不適合が出ても、
// 実装と判定にすでに費やしたものは戻らない。実測: ドメイン固有の器官を作った回は、
// 実装と2回の判定で30万トークンを使い切ってから、人間の指摘で破棄になった。
//
// 受け入れ条件は「設計判断が符号化される地点」であり、計画登録の瞬間はまだ何も
// 作っていないので方向を変えられる。ここで判定させるのが最も安い。
//
// 判定するのは独立サブエージェントであって人間ではない。**人間に確認を上げる機構ではない** —
// 判断できるはずのことを差し戻すのは、この装置が埋めようとしている不足そのものである。
const path = require('node:path');
const { nowIso, atomicWriteFile, readTextFile, estimateTokens, appendJsonl } = require('./util');

// 判定基準の正本。briefingはここから引く（文面を二重に持たない）
const EVALUATOR_ID = 'plan_alignment';

// 目的の側の材料。実行者の申告ではなく、goal.yaml と確立済みの方針だけを渡す。
function goalMaterial(osDir) {
  const L = [];
  let goal;
  try {
    goal = require('./schema').loadGoal(osDir);
  } catch (e) {
    return [`（goal.yamlを読めなかった: ${e.message}）`, ''];
  }
  L.push('## 記録された目的（goal.yaml。実行者が書き換えられない側の記録）');
  L.push('');
  L.push(`goal: ${goal.goal || '(未記載)'}`);
  if (Array.isArray(goal.objectives) && goal.objectives.length) {
    L.push(`objectives: ${goal.objectives.join(', ')}`);
  }
  L.push('');
  if (Array.isArray(goal.success_criteria) && goal.success_criteria.length) {
    L.push('success_criteria:');
    for (const c of goal.success_criteria) {
      L.push(`- ${c.id}: ${c.statement}（evaluator: ${c.evaluator || 'unbound'}）`);
    }
    L.push('');
  }
  if (Array.isArray(goal.constraints) && goal.constraints.length) {
    L.push('constraints:');
    for (const c of goal.constraints) {
      L.push(`- ${c.id} [${c.severity || 'soft'}]: ${c.statement}（evaluator: ${c.evaluator || 'unbound'}）`);
    }
    L.push('');
  }
  return L;
}

// 同じ場について既に確立している方針。判定者が「この計画は既決の方針に反していないか」を
// 見るための材料で、方針が無ければ無いと書く（無いことを隠さない）。
function policyMaterial(osDir, task) {
  const L = ['## 確立済みの方針（rules/policy-*.yaml。反復して結果が伴った判断の畳み込み）', ''];
  let list = [];
  try {
    list = require('./policy').listPolicies(osDir, { activeOnly: true }) || [];
  } catch {
    list = [];
  }
  if (!list.length) {
    L.push('確立済みの方針は無い。この計画は既決の判断に照らして評価できない。');
    L.push('');
    return L;
  }
  for (const p of list.slice(0, 10)) {
    L.push(`- ${p.situation || p.fingerprint}: ${p.choose}（根拠: ${(p.from || []).join(', ') || '不明'}）`);
  }
  L.push('');
  return L;
}

// 計画の目的適合を判定させるbriefing。完成物ではなく計画そのものを対象にする。
function preparePlanReview(osDir, task, planAbsPath, planRelPath) {
  const parts = [];
  parts.push(`# 計画の目的適合の独立判定: ${task.id}`);
  parts.push('');
  parts.push('あなたは独立評価者である。この計画はまだ実行されていない。');
  parts.push('生成エージェントの会話履歴・説明は一切参照せず、下の材料だけで判定せよ。');
  parts.push('**判定するのは計画の出来ではなく、目的への適合である。**');
  parts.push('');
  parts.push(`## タスクのObjective: ${task.objective}`);
  parts.push('');
  // 原文接地: 意図の曲解は言い換え（objective化）の瞬間に起きる。原文があれば、
  // 計画の適合はまず原文に対して判定する — objectiveは実行者の言い換えである。
  if (task.verbatim) {
    parts.push('## ユーザー依頼の原文（登録時に固定・不可変）');
    parts.push('');
    parts.push('```');
    parts.push(String(task.verbatim).trimEnd());
    parts.push('```');
    parts.push('');
    parts.push('**Objectiveは実行者による言い換えである。** 計画がこの原文の意図から');
    parts.push('逸れていないか（要求の縮小・すり替え）を、goal.yamlとの適合より先に確かめよ。');
    parts.push('');
  } else {
    parts.push('（このタスクにはユーザー依頼の原文が記録されていない。');
    parts.push('Objectiveが依頼の正確な写しかは検証できない）');
    parts.push('');
  }
  parts.push(...goalMaterial(osDir));
  parts.push(...policyMaterial(osDir, task));
  parts.push(`## 事前固定された計画（${planRelPath}）`);
  parts.push('');
  parts.push('```markdown');
  try {
    parts.push(readTextFile(planAbsPath).replace(/\r\n/g, '\n').trimEnd());
  } catch (e) {
    parts.push(`(計画を読めなかった: ${e.message})`);
  }
  parts.push('```');
  parts.push('');
  // rubricは evaluator 定義（plan_alignment.yaml）を正本として読む。
  // briefing側にも同じ文面を持つと、片方だけ直した瞬間に「判定基準が2つある」状態になる
  // （検証装置が検証対象の複製を持つのと同じ形の欠陥）。
  parts.push('## Rubric（正本: evaluators/plan_alignment.yaml）');
  parts.push('');
  try {
    const def = require('./evaluate').loadEvaluatorDef(osDir, EVALUATOR_ID);
    parts.push(String(def.rubric).trimEnd());
  } catch (e) {
    // 読めないことを黙って通さない。判定基準が無いまま判定させるより、その事実を渡す
    parts.push(`（${EVALUATOR_ID} の定義を読めなかった: ${e.message}）`);
    parts.push('判定基準が引けない状態では判定できない。UNCERTAIN（reason: insufficient_evidence）とせよ。');
  }
  parts.push('');
  parts.push('## 出力方法');
  parts.push('');
  parts.push('    node cli/index.js verdict --file <判定JSONのパス>');
  parts.push('');
  parts.push('```json');
  parts.push(JSON.stringify({
    task: task.id,
    evaluator: EVALUATOR_ID,
    verdict: 'PASS | FAIL | UNCERTAIN',
    evidence: ['計画のどの受け入れ条件が、目的のどこに対してどうなのかを引用して示す'],
    rationale: '判定理由',
    tier: 'T1',
  }, null, 1));
  parts.push('```');
  const file = path.join(osDir, 'briefings', `plan-${task.id}.md`);
  const text = parts.join('\n') + '\n';
  atomicWriteFile(file, text);
  appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
    ts: nowIso(),
    kind: 'plan_review_briefing',
    task: task.id,
    plan: planRelPath,
    tokens_est: estimateTokens(text),
  });
  return { file, tokens_est: estimateTokens(text) };
}

module.exports = { preparePlanReview };
