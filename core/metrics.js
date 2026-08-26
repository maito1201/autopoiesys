'use strict';
// OS Quality Metrics（CONCEPT §18）とToken Economicsの計測（§14）。
// Token Ledger・verdict台帳・query_logから集計し、コンパイル候補（metrics駆動コンパイル）を提案する。
const path = require('node:path');
const { readJsonl } = require('./util');
const { loadTasks } = require('./evaluate');
const { loadFailures, TERMINAL } = require('./failure');

function computeMetrics(osDir) {
  const costs = readJsonl(path.join(osDir, 'observations', 'costs.jsonl'));
  const verdicts = readJsonl(path.join(osDir, 'evaluations', 'log.jsonl'));
  const queryLog = readJsonl(path.join(osDir, 'observations', 'query_log.jsonl'));
  const tasks = loadTasks(osDir);
  const failures = loadFailures(osDir);

  // Token Ledger集計
  const byTier = {};
  const byTask = {};
  let totalTokens = 0;
  for (const c of costs) {
    const t = (c.tokens_in || 0) + (c.tokens_out || 0);
    totalTokens += t;
    byTier[c.tier || '?'] = (byTier[c.tier || '?'] || 0) + t;
    if (c.task) byTask[c.task] = (byTask[c.task] || 0) + t;
  }
  // cheap-path coverage: LLM記録のあるタスクのうちT2/T3を使わなかった割合
  const tasksWithCosts = new Set(costs.filter((c) => c.task).map((c) => c.task));
  const tasksWithExpensive = new Set(costs.filter((c) => c.task && (c.tier === 'T2' || c.tier === 'T3')).map((c) => c.task));
  const cheapPathCoverage = tasksWithCosts.size
    ? (tasksWithCosts.size - tasksWithExpensive.size) / tasksWithCosts.size
    : null;

  // verdict集計
  const verdictCounts = { PASS: 0, FAIL: 0, UNCERTAIN: 0 };
  let detVerdicts = 0;
  for (const v of verdicts) {
    verdictCounts[v.verdict] = (verdictCounts[v.verdict] || 0) + 1;
    if (v.provenance === 'deterministic') detVerdicts++;
  }

  // Query集計とコンパイル候補（切詰め率・頻度の高いQueryは決定的コードへの昇格候補）
  const queryStats = {};
  for (const q of queryLog) {
    const s = (queryStats[q.query] = queryStats[q.query] || { runs: 0, truncated: 0, tokens: 0 });
    s.runs++;
    if (q.truncated) s.truncated++;
    s.tokens += q.tokens_est || 0;
  }
  const compileCandidates = [];
  for (const [name, s] of Object.entries(queryStats)) {
    const truncRate = s.truncated / s.runs;
    if (s.runs >= 5 && truncRate > 0.3) {
      compileCandidates.push({
        kind: 'query',
        ref: name,
        reason: `実行${s.runs}回・切詰め率${Math.round(truncRate * 100)}% — 出力設計の見直しか決定的コードへの昇格を検討`,
      });
    }
  }
  // T2/T3で反復されているpurposeもコンパイル候補
  const purposeCount = {};
  for (const c of costs) {
    if (c.tier === 'T2' || c.tier === 'T3') {
      purposeCount[c.purpose || '?'] = (purposeCount[c.purpose || '?'] || 0) + 1;
    }
  }
  for (const [purpose, n] of Object.entries(purposeCount)) {
    if (n >= 3) {
      compileCandidates.push({
        kind: 'procedure',
        ref: purpose,
        reason: `${purpose} がT2/T3で${n}回反復 — rule/query/evaluatorへのコンパイル候補（§14）`,
      });
    }
  }

  // Failure集計
  const failureList = Object.values(failures);
  const openFailures = failureList.filter((f) => !TERMINAL.includes(f.state));
  const humanInterventions = failureList.filter((f) => f.source === 'user_feedback').length;

  const taskList = Object.values(tasks);
  return {
    tasks: {
      total: taskList.length,
      done: taskList.filter((t) => t.status === 'done').length,
    },
    tokens: {
      total: totalTokens,
      by_tier: byTier,
      by_task: byTask,
      cheap_path_coverage: cheapPathCoverage,
    },
    verdicts: {
      counts: verdictCounts,
      deterministic_ratio: verdicts.length ? detVerdicts / verdicts.length : null,
      total: verdicts.length,
    },
    queries: queryStats,
    failures: {
      total: failureList.length,
      open: openFailures.length,
      human_interventions: humanInterventions,
    },
    compile_candidates: compileCandidates,
  };
}

module.exports = { computeMetrics };
