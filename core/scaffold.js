'use strict';
// 環境診断（doctor）とユーザー固有OS（.os/）の雛形生成（init）。
// initはOSを作らない — 構造だけを置き、中身はヒアリングとBuild Skillが埋める。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWriteFile } = require('./util');
const { FORMAT_VERSION } = require('./schema');

function doctor() {
  const report = { ok: true, checks: [] };
  const major = parseInt(process.versions.node.split('.')[0], 10);
  report.checks.push({
    name: 'node',
    ok: major >= 20,
    detail: `v${process.versions.node}${major >= 20 ? '' : '（>=20が必要）'}`,
  });
  const gitRes = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  report.checks.push({
    name: 'git',
    ok: !gitRes.error && gitRes.status === 0,
    detail: gitRes.error ? 'git不在（履歴の観測とOSバージョン管理に必要）' : (gitRes.stdout || '').trim(),
  });
  report.checks.push({ name: 'platform', ok: true, detail: `${process.platform} ${process.arch}` });
  report.ok = report.checks.every((c) => c.ok || c.name === 'git');
  return report;
}

const CONFIG_TEMPLATE = `format_version: ${FORMAT_VERSION}
os_version: 1
routing:
  T0: deterministic
  T1: { model: cheap, use_for: [classification, summary, checklist] }
  T2: { model: mid, use_for: [planning, integration] }
  T3: { model: high, use_for: [unknown_problem, critical_failure, contradiction, os_redesign] }
  escalation:
    - uncertain_verdict
    - unknown_fingerprint
    - conflicting_evidence
budgets:
  research_tokens: 200000
strict_vocabulary: false
stale_after_days: 7
`;

const GOAL_TEMPLATE = `# init-os Skillのヒアリングで生成する。手で書く場合はSCHEMA.md参照。
goal: (ユーザーが達成したい状態を自然文で)
domain: (領域名)
objectives:
  - (目的の分解)
success_criteria:
  - id: sc-001
    statement: (何が起きたら成功か)
    evaluator: unbound
constraints:
  - id: c-001
    statement: (絶対にやってはいけないこと)
    severity: hard
    evaluator: unbound
autonomy:
  escalate_on:
    - (人間に委ねる条件)
optimization:
  - correctness
sources:
  - repo: .
notes: |
  (ヒアリング原文)
`;

const VOCABULARY_TEMPLATE = `# predicate / tag の登録簿。未登録は警告（strict_vocabulary: trueでエラー）。
# 実績で安定した語彙から登録していく（最初から完璧を目指さない — CONCEPT §26⑥）。
predicates:
  - affects
  - depends_on
tags:
  - repo
  - inventory
  - layout
  - git-log
  - git-status
  - git-branch
`;

const OS_README = `# .os/ — ユーザー固有Intelligence OS

このディレクトリはautopoiesys OSS Coreが生成・操作するユーザー固有OSである。
形式契約はOSS側のSCHEMA.mdを参照。全状態変化はgit diffで監査できる。
OSS本体とは分離して、このディレクトリ自体を独立にバージョン管理することを推奨する。
`;

function initOs(targetDir, { force = false } = {}) {
  const osDir = path.join(targetDir, '.os');
  if (fs.existsSync(path.join(osDir, 'config.yaml')) && !force) {
    throw new Error(`.os/ は既に存在する: ${osDir}（上書きは --force）`);
  }
  const dirs = [
    'world_model', 'queries', 'evaluators', 'rules', 'tasks', 'evaluations',
    'failures', 'golden_tasks', 'briefings', 'proposals', 'plugins', 'observations',
  ];
  for (const d of dirs) fs.mkdirSync(path.join(osDir, d), { recursive: true });
  atomicWriteFile(path.join(osDir, 'config.yaml'), CONFIG_TEMPLATE);
  if (!fs.existsSync(path.join(osDir, 'goal.yaml'))) {
    atomicWriteFile(path.join(osDir, 'goal.yaml'), GOAL_TEMPLATE);
  }
  atomicWriteFile(path.join(osDir, 'world_model', 'vocabulary.yaml'), VOCABULARY_TEMPLATE);
  atomicWriteFile(path.join(osDir, 'README.md'), OS_README);
  return { osDir, created: dirs };
}

module.exports = { doctor, initOs };
