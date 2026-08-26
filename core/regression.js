'use strict';
// OS Regression（CONCEPT §17）: golden task全件 + failure lint + 整合検査。
// llm_judgeはreplay（記録済みverdict）に置換され、回帰は決定的に走る。
// fixture付きcheckは検出力テスト（既知の悪い状態に対して検出器が実際にFAILを出せるか）。
const path = require('node:path');
const fs = require('node:fs');
const { loadEvaluatorDef, runDeterministic, runCommand } = require('./evaluate');
const { listGoldenTasks, checkAll, loadConfig } = require('./schema');
const { listQueries, loadQueryDef, runQuery } = require('./query');

// Query定義に添付されたgolden（期待件数）を検証する — Query自体を回帰対象にする
function runQueryGoldens(osDir) {
  const results = [];
  for (const name of listQueries(osDir)) {
    let def;
    try {
      def = loadQueryDef(osDir, name);
    } catch {
      continue; // 定義エラーはcheckAll側で報告される
    }
    if (!def.golden) continue;
    try {
      const r = runQuery(osDir, name, def.golden.params || {});
      const checks = [];
      if (def.golden.expect_min_count !== undefined) {
        checks.push({ rule: `total >= ${def.golden.expect_min_count}`, ok: r.total >= def.golden.expect_min_count });
      }
      if (def.golden.expect_count !== undefined) {
        checks.push({ rule: `total == ${def.golden.expect_count}`, ok: r.total === def.golden.expect_count });
      }
      results.push({ query: name, total: r.total, checks, pass: checks.every((c) => c.ok) });
    } catch (e) {
      results.push({ query: name, checks: [], pass: false, error: e.message });
    }
  }
  return results;
}

function runGoldenCheck(osDir, check, { repoRoot }) {
  const def = loadEvaluatorDef(osDir, check.evaluator);
  const expected = check.expected || check.replay;
  let actual;
  let evidence;
  if (check.replay) {
    // llm_judge等の記録済みverdictをリプレイ（実LLMは呼ばない）
    actual = check.replay;
    evidence = ['replay'];
  } else if (def.method === 'llm_judge') {
    actual = 'UNCERTAIN';
    evidence = ['llm_judgeはregressionではreplay必須（checkにreplay: <verdict>を記録する）'];
  } else {
    const workDir = check.fixture ? path.resolve(repoRoot, check.fixture) : repoRoot;
    if (check.fixture && !fs.existsSync(workDir)) {
      return { evaluator: check.evaluator, expected, actual: 'UNCERTAIN', pass: false, evidence: [`fixtureが存在しない: ${check.fixture}`] };
    }
    const r = def.method === 'deterministic'
      ? runDeterministic(osDir, def, { workDir })
      : runCommand(def, { workDir });
    actual = r.verdict;
    evidence = r.evidence;
  }
  return {
    evaluator: check.evaluator,
    fixture: check.fixture,
    expected,
    actual,
    pass: actual === expected,
    evidence,
  };
}

function runRegression(osDir, { repoRoot, now } = {}) {
  const root = repoRoot || process.cwd();
  const cfg = loadConfig(osDir);
  const golden = [];
  for (const { file, def } of listGoldenTasks(osDir)) {
    if (!def) {
      golden.push({ id: path.basename(file), pass: false, checks: [], error: '読込失敗' });
      continue;
    }
    const checks = (def.checks || []).map((c) => runGoldenCheck(osDir, c, { repoRoot: root }));
    golden.push({
      id: def.id,
      origin_failure: def.origin_failure,
      checks,
      pass: checks.length > 0 && checks.every((c) => c.pass),
    });
  }
  const queryGoldens = runQueryGoldens(osDir);
  const check = checkAll(osDir, { now });
  const failureLint = check.failure_lint || [];
  const pass = golden.every((g) => g.pass)
    && queryGoldens.every((q) => q.pass)
    && failureLint.length === 0
    && check.errors.length === 0;
  return {
    pass,
    golden_total: golden.length,
    golden_passed: golden.filter((g) => g.pass).length,
    golden,
    query_goldens: queryGoldens,
    failure_lint: failureLint,
    check_errors: check.errors,
    check_warnings: check.warnings,
    os_version: cfg.os_version,
  };
}

module.exports = { runRegression };
