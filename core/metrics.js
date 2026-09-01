'use strict';
// OS Quality Metrics（設計原則§18）とToken Economicsの計測（§14）。
// Token Ledger・verdict台帳・query_logから集計し、コンパイル候補（metrics駆動コンパイル）を提案する。
const path = require('node:path');
const { readJsonl } = require('./util');
const { loadTasks } = require('./evaluate');
const { loadFailures, TERMINAL } = require('./failure');

function computeMetrics(osDir) {
  const costs = readJsonl(path.join(osDir, 'observations', 'costs.jsonl'));
  const verdicts = readJsonl(path.join(osDir, 'evaluations', 'log.jsonl'));
  const queryLog = readJsonl(path.join(osDir, 'observations', 'query_log.jsonl'));
  const contextLog = readJsonl(path.join(osDir, 'observations', 'context_log.jsonl'));
  const tasks = loadTasks(osDir);
  const failures = loadFailures(osDir);

  // Token Ledger集計
  const byTier = {};
  const byTask = {};
  let totalTokens = 0;
  let estimatedTokens = 0;
  let measuredTokens = 0;
  let entriesWithoutTokens = 0;
  for (const c of costs) {
    // tokens_total は「内訳が分からない実測」（サブエージェントの消費合計など）の受け皿で、
    // ledger add の usage が案内している経路である。ここで見ないと、**実測を入れられる
    // 唯一の経路が集計から落ち**、measured は永久に0のままになる（実際にそうなっていた）。
    // 内訳と合計が両方ある行は合計を採る — 「内訳が分からないときに使う」という宣言なので
    // 両立は矛盾であり、どちらか一方に倒すことを明示する。
    if (c.tokens_in === undefined && c.tokens_out === undefined && c.tokens_total === undefined) {
      entriesWithoutTokens++;
      continue;
    }
    const t = c.tokens_total !== undefined
      ? (c.tokens_total || 0)
      : (c.tokens_in || 0) + (c.tokens_out || 0);
    totalTokens += t;
    // estimated未設定の旧エントリは出所が判別できない。見積り側に寄せて
    // 「実測である」と誤読させない
    if (c.estimated === false) measuredTokens += t;
    else estimatedTokens += t;
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

  // Context消費の実測（§14 / A1）。自己申告のToken Ledgerとは別系統で、
  // OSが実際に生成したbriefingとQuery結果の大きさだけを数える。
  let briefingTokensTotal = 0;
  const contextPerTask = {};
  for (const c of contextLog) {
    if (c.kind !== 'briefing') continue;
    const t = c.tokens_est || 0;
    briefingTokensTotal += t;
    if (c.task) contextPerTask[c.task] = (contextPerTask[c.task] || 0) + t;
  }
  let queryTokensTotal = 0;
  for (const q of queryLog) queryTokensTotal += q.tokens_est || 0;

  // 方針層（直感）の実測。**発火数と節約トークン量を成功指標にしない** —
  // 大量に発火したことは、正しく発火したことを意味しない。判定に要るのは
  // 「方針が発火した判断の結末」と「熟慮した判断の結末」の比較である。
  // 方針が熟慮より悪ければ、この層は害であり、それはここで観測できなければならない。
  const policyEvents = { hits: 0, compiled: 0, retracted: 0 };
  for (const c of contextLog) {
    if (c.kind === 'policy_hit') policyEvents.hits++;
    else if (c.kind === 'policy_compiled') policyEvents.compiled++;
    else if (c.kind === 'policy_retracted') policyEvents.retracted++;
  }
  const policyOutcomes = { under_policy: { met: 0, unmet: 0, unclear: 0 }, deliberate: { met: 0, unmet: 0, unclear: 0 } };
  let activePolicies = 0;
  try {
    const policy = require('./policy');
    const all = policy.listPolicies(osDir);
    activePolicies = all.filter((p) => p.status === 'active').length;
    // 方針が既に存在した判断の場での決定か、そうでないかで結果を分ける。
    // 方針の evidence に載っている決定（方針の元になった決定）は熟慮側に数える
    const compiledFps = new Set(all.map((p) => p.fingerprint));
    const evidenceIds = new Set(all.flatMap((p) => p.evidence || []));
    for (const bucket of Object.values(policy.foldByFingerprint(osDir))) {
      for (const d of bucket.decisions) {
        const side = compiledFps.has(bucket.fingerprint) && !evidenceIds.has(d.id) ? 'under_policy' : 'deliberate';
        for (const o of d.outcomes) {
          if (policyOutcomes[side][o.result] !== undefined) policyOutcomes[side][o.result]++;
        }
      }
    }
  } catch {
    // World Model未整備でもmetrics全体を落とさない
  }

  // 制度の計器。このOSが機能しているかを決める唯一のグラフは
  // 「タスクあたり検収の限界トークン（LLM判定のbriefing実測）が下がっているか」である。
  // 下がる構造 = 失敗の検出器化（CAPEX）・較正による抜き取り化・現実への転嫁が効いている。
  // 平坦なら、このOSはただのバトル会場である。
  let institution = null;
  try {
    const claims = require('./claims');
    const calibration = claims.calibration(osDir);
    // 類型ごとの較正（宣言のあるタスクの類型だけ）
    const byClass = {};
    for (const t of Object.values(tasks)) {
      if (!t.class_fp || byClass[t.class_fp]) continue;
      const cal = claims.calibration(osDir, { classFp: t.class_fp });
      if (cal.claims) byClass[t.class_fp] = { class: t.class, ...cal };
    }
    // 監査経済: 実施した判定（briefing生成）と免除（sampled_out）・同一状態スキップ
    const audit = { briefings: 0, sampled_out: 0, skipped_unchanged: 0 };
    for (const c of contextLog) {
      if (c.kind === 'briefing') audit.briefings++;
      else if (c.kind === 'audit_sampled_out') audit.sampled_out++;
      else if (c.kind === 'briefing_skipped') audit.skipped_unchanged++;
    }
    // 検収限界コストの系列: 完了タスクごとのbriefing実測トークン（タスクid順 = 時系列近似）。
    // 傾向は前半平均と後半平均の比較（実測が4件未満なら出さない — 2点で傾向を語らない）
    const completed = Object.values(tasks)
      .filter((t) => require('./evaluate').isCompleted(t))
      .map((t) => t.id)
      .sort();
    const series = completed.map((id) => ({ task: id, briefing_tokens: contextPerTask[id] || 0 }));
    let trend = null;
    if (series.length >= 4) {
      const half = Math.floor(series.length / 2);
      const avg = (a) => a.reduce((s, x) => s + x.briefing_tokens, 0) / a.length;
      const first = avg(series.slice(0, half));
      const second = avg(series.slice(-half));
      trend = {
        first_half_avg: Math.round(first),
        second_half_avg: Math.round(second),
        falling: second < first,
      };
    }
    institution = {
      calibration,
      calibration_by_class: byClass,
      audit,
      verification_marginal: { series, trend },
    };
  } catch {
    // claims台帳が未整備でもmetrics全体を落とさない
  }

  // Failure集計
  const failureList = Object.values(failures);
  const openFailures = failureList.filter((f) => !TERMINAL.includes(f.state));
  const humanInterventions = failureList.filter((f) => f.source === 'user_feedback').length;

  const taskList = Object.values(tasks);
  return {
    tasks: {
      total: taskList.length,
      done: taskList.filter((t) => require('./evaluate').isCompleted(t)).length,
    },
    tokens: {
      total: totalTokens,
      // 手入力の見積りと実測を混ぜたままコスト判断をしない（optimization: token_efficiency）
      measured: measuredTokens,
      estimated: estimatedTokens,
      entries_without_tokens: entriesWithoutTokens,
      by_tier: byTier,
      by_task: byTask,
      cheap_path_coverage: cheapPathCoverage,
    },
    verdicts: {
      counts: verdictCounts,
      deterministic_ratio: verdicts.length ? detVerdicts / verdicts.length : null,
      total: verdicts.length,
    },
    context: {
      briefing_tokens_total: briefingTokensTotal,
      query_tokens_total: queryTokensTotal,
      per_task: contextPerTask,
    },
    policy: {
      active: activePolicies,
      hits: policyEvents.hits,
      compiled: policyEvents.compiled,
      retracted: policyEvents.retracted,
      // この2列の比較だけが方針層の是非を決める。発火数はここに入れない
      outcomes: policyOutcomes,
    },
    queries: queryStats,
    failures: {
      total: failureList.length,
      open: openFailures.length,
      human_interventions: humanInterventions,
    },
    institution,
    compile_candidates: compileCandidates,
  };
}

module.exports = { computeMetrics };
