'use strict';
// Intelligence Gap Analysis（CONCEPTv2 §6）。
// Goalノードから requires/depends_on 辺で到達するRequired Intelligenceを、
// 現在のOS（World Model・evaluators・queries・verdict台帳・goal.yaml）と突合し、
// AVAILABLE / MISSING / UNCERTAIN / CONFLICTING / STALE / UNVERIFIED / UNMET に分類する。
// 「意味の提案はLLM（decompose-goal Skill）、実在と健全性の判定は決定的コア（本モジュール）」。
// 分類結果は保存せず毎回再計算する（保存した瞬間にそれ自体がSTALE化するため）。
const fs = require('node:fs');
const path = require('node:path');
const { readJsonl, sha1, nowIso } = require('./util');
const store = require('./store');
const { traverseGraph } = require('./query');
const { loadGoal } = require('./schema');

const CLASSIFICATIONS = ['AVAILABLE', 'MISSING', 'UNCERTAIN', 'CONFLICTING', 'STALE', 'UNVERIFIED', 'UNMET'];
const REQUIRE_KINDS = ['requires', 'depends_on'];
const BINDING_KINDS = ['evaluated_by', 'measured_by', 'requires', 'depends_on'];
// 束縛辺（評価器等への接地）を必須とするノード型。claim等の知識ノードはそれ自体が知識であり、
// 可用性は自身のstatus/証拠で判定する
const NEEDS_BINDING = ['capability', 'decision'];
// 「llm由来かつ証拠ゼロ→UNVERIFIED」を適用する知識系ノード型。
// capability/decisionはLLM分解由来が本性なので、検証は束縛先evaluatorのverdict有無で測る
const KNOWLEDGEISH = ['claim', 'observation', 'hypothesis', 'fact', 'constraint', 'entity', 'concept'];

// 各分類に対する次の一手（CONCEPTv2 §13: 無理に答えを生成せず次のActionを提案する）
const NEXT_ACTIONS = {
  MISSING: 'decompose-goal で分解を深めるか、build-evaluation-model / build-query-system で資産を作る',
  UNVERIFIED: '証拠を集める（supports リンク）か、束縛evaluatorを一度実行してverdictを残す',
  // 測って落ちている基準。『測れていない』と同じ扱いにすると、実測した瞬間に未達が見えなくなる
  UNMET: '最新のverdictがFAIL。fail_reasonがinsufficient_sampleなら手法ではなく標本を足す',
  UNCERTAIN: 'Research / Experiment / Measurement で確信度を上げる（または反証する）',
  CONFLICTING: '矛盾する証拠を突き合わせて解消する（RESOLVE_CONFLICT）',
  STALE: '再検証して supersede するか、retract する',
};

function verdictCountByEvaluator(osDir) {
  const counts = {};
  for (const v of readJsonl(path.join(osDir, 'evaluations', 'log.jsonl'))) {
    counts[v.evaluator] = (counts[v.evaluator] || 0) + 1;
  }
  return counts;
}

// evaluatorごとの最新verdict（タスクを跨いだ最終行。latestVerdictsと同じ規則）。
// 件数だけを見ると「測って不合格」が「測って問題なし」と同じ枝に落ちる（F010）
function latestVerdictByEvaluator(osDir) {
  const latest = {};
  for (const v of readJsonl(path.join(osDir, 'evaluations', 'log.jsonl'))) {
    if (v && v.evaluator) latest[v.evaluator] = v;
  }
  return latest;
}

// 1ノードの分類（優先順位つき決定表）。戻り値 {classification, why, bindings}
function classifyNode(node, ctx) {
  const { snapshot, allIds, assetCheck, verdictCounts, floor, staleMs, nowMs } = ctx;
  const edgesOut = snapshot.indexes.edges_out || {};
  const edgesIn = snapshot.indexes.edges_in || {};

  // asset ref（World Model外の台帳参照）
  if (node.type === 'ref') {
    if (!assetCheck(node.id)) {
      return { classification: 'MISSING', why: `参照先が実在しない: ${node.id}`, bindings: [] };
    }
    const m = /^evaluator:(.+)$/.exec(node.id);
    if (m && !verdictCounts[m[1]]) {
      return { classification: 'UNVERIFIED', why: `evaluator ${m[1]} は実在するがverdict記録がゼロ（一度も実行されていない）`, bindings: [] };
    }
    return { classification: 'AVAILABLE', why: '参照先が実在する', bindings: [] };
  }

  const inEdges = edgesIn[node.id] || [];
  const outEdges = edgesOut[node.id] || [];
  const bindings = outEdges.filter((e) => BINDING_KINDS.includes(e.kind));
  const supports = inEdges.filter((e) => e.kind === 'supports');
  const counters = inEdges.filter((e) => e.kind === 'counters');

  // 1. CONFLICTING
  const contradicts = [...inEdges, ...outEdges].filter((e) => e.kind === 'contradicts');
  if (contradicts.length) {
    return { classification: 'CONFLICTING', why: `contradicts辺が接続: ${contradicts.map((e) => e.via).join(', ')}`, bindings };
  }
  if (supports.length && counters.length) {
    return { classification: 'CONFLICTING', why: `支持(${supports.length})と反証(${counters.length})が併存`, bindings };
  }

  // 2. MISSING
  if (NEEDS_BINDING.includes(node.type) && bindings.length === 0) {
    return {
      classification: 'MISSING',
      why: `${node.type}に束縛辺（${BINDING_KINDS.join('/')}）が1本も無い — 知識はあっても判定・分解に接地していない`,
      bindings,
    };
  }
  const deadBindings = bindings.filter((e) => {
    if (snapshot.statements[e.to]) return false;
    if (store.isAssetRef(e.to)) return !assetCheck(e.to);
    return !allIds.has(e.to); // allIdsにあればSTALE側で扱う
  });
  if (deadBindings.length) {
    return { classification: 'MISSING', why: `束縛先が全台帳に不在: ${deadBindings.map((e) => e.to).join(', ')}`, bindings };
  }

  // 3. STALE
  const supersededBindings = bindings.filter((e) => !snapshot.statements[e.to] && !store.isAssetRef(e.to) && allIds.has(e.to));
  if (supersededBindings.length) {
    return { classification: 'STALE', why: `束縛先がsupersede/retract済み: ${supersededBindings.map((e) => e.to).join(', ')}`, bindings };
  }
  if (supports.length) {
    let newest = 0;
    for (const e of supports) {
      const src = snapshot.statements[e.from];
      const t = src && src.ts ? Date.parse(src.ts) : 0;
      if (t > newest) newest = t;
    }
    if (newest && nowMs - newest > staleMs) {
      const days = Math.floor((nowMs - newest) / 86400000);
      return { classification: 'STALE', why: `最新の支持証拠が${days}日前（stale_after_days超過）— 再検証されていない`, bindings };
    }
  }

  // 4. UNVERIFIED
  if (KNOWLEDGEISH.includes(node.type) && supports.length === 0
      && node.provenance && node.provenance.method === 'llm') {
    return { classification: 'UNVERIFIED', why: 'llm由来で支持証拠がゼロ（観測に接地していない）', bindings };
  }
  const boundEvaluators = bindings
    .map((e) => /^evaluator:(.+)$/.exec(e.to))
    .filter(Boolean)
    .map((m) => m[1]);
  const neverRun = boundEvaluators.filter((id) => !verdictCounts[id]);
  if (boundEvaluators.length && neverRun.length === boundEvaluators.length) {
    return { classification: 'UNVERIFIED', why: `束縛evaluator（${neverRun.join(', ')}）のverdict記録がゼロ`, bindings };
  }

  // 5. UNCERTAIN
  // 束縛型ノード（capability/decision）は「必要かどうか」の仮説性をrequires辺が担い、
  // 可用性は束縛の実在と検証実績で測る — status:hypothesisだけではUNCERTAINにしない。
  // 知識系ノードは自身のstatusが可用性そのものなのでhypothesis=UNCERTAIN。
  if (node.status === 'hypothesis' && !NEEDS_BINDING.includes(node.type)) {
    return { classification: 'UNCERTAIN', why: `仮説のまま（confidence=${node.confidence !== undefined ? node.confidence : '未設定'}）`, bindings };
  }
  if (node.confidence !== undefined && node.confidence < floor) {
    return { classification: 'UNCERTAIN', why: `confidence ${node.confidence} < 閾値 ${floor}`, bindings };
  }

  // 6. AVAILABLE
  return { classification: 'AVAILABLE', why: '束縛・証拠・確信度に問題なし', bindings };
}

// goal.yamlのsuccess_criteria/constraints（evaluator接地）もGapの対象に含める —
// 既存のunbound可視化をGap Analysisの語彙に統合する
function goalCriteriaGaps(osDir, verdictCounts) {
  const goal = loadGoal(osDir);
  const latest = latestVerdictByEvaluator(osDir);
  const items = [];
  if (!goal) return items;
  for (const listName of ['success_criteria', 'constraints']) {
    for (const item of goal[listName] || []) {
      if (!item || !item.id) continue;
      let classification;
      let why;
      if (!item.evaluator || item.evaluator === 'unbound') {
        classification = 'MISSING';
        why = 'evaluatorがunbound（判定器が存在しない）';
      } else if (!fs.existsSync(path.join(osDir, 'evaluators', `${item.evaluator}.yaml`))) {
        classification = 'MISSING';
        why = `evaluator ${item.evaluator} が実在しない`;
      } else if (!verdictCounts[item.evaluator]) {
        classification = 'UNVERIFIED';
        why = `evaluator ${item.evaluator} のverdict記録がゼロ`;
      } else if (latest[item.evaluator] && latest[item.evaluator].verdict === 'FAIL') {
        // 実測した結果の不合格。AVAILABLEに吸い込むと、測った瞬間に未達が見えなくなる（F010）
        const v = latest[item.evaluator];
        classification = 'UNMET';
        why = `evaluator ${item.evaluator} の最新verdictがFAIL`
          + `${v.reason ? `（reason: ${v.reason}）` : ''}${v.ts ? ` / ${v.ts}` : ''}`;
      } else {
        classification = 'AVAILABLE';
        why = `evaluator ${item.evaluator} が実在しverdict記録あり`;
      }
      items.push({
        id: `${listName}:${item.id}`,
        type: 'goal_criterion',
        body: item.statement,
        classification,
        why,
      });
    }
  }
  return items;
}

// Gap Analysis本体。goalId省略時はWorld Modelのgoalノードが1件ならそれを使う。
// criteriaOnly: goalノード未整備でも goal.yaml の評価器接地だけを検査するモード。
function gapAnalysis(osDir, { goalId, floor, staleAfterDays, now, depth = 5, criteriaOnly = false } = {}) {
  const verdictCountsEarly = verdictCountByEvaluator(osDir);
  if (criteriaOnly) {
    const required = goalCriteriaGaps(osDir, verdictCountsEarly);
    const summary = {};
    for (const c of CLASSIFICATIONS) summary[c] = required.filter((r) => r.classification === c).length;
    const nextActions = {};
    for (const [cls, action] of Object.entries(NEXT_ACTIONS)) if (summary[cls]) nextActions[cls] = action;
    return { goal: '(goal.yaml)', required_total: required.length, summary, required, next_actions: nextActions };
  }
  const snapshot = store.getSnapshot(osDir);
  const goals = snapshot.indexes.by_type.goal || [];
  let root = goalId;
  if (!root) {
    if (goals.length === 1) root = goals[0];
    else if (goals.length === 0) {
      throw new Error(
        'World Modelにgoalノードが無い。decompose-goal Skillでgoal.yamlをノード化してから実行する' +
        '（goal.yamlの評価器接地だけなら --criteria-only で検査できる）'
      );
    } else {
      throw new Error(`goalノードが複数ある。--goal で指定する: ${goals.join(', ')}`);
    }
  }
  if (!snapshot.statements[root]) throw new Error(`goalノードが現在状態に存在しない: ${root}`);

  const events = store.loadEvents(osDir);
  const allIds = new Set(events.map((e) => e.id));
  const verdictCounts = verdictCountsEarly;
  const ctx = {
    snapshot,
    allIds,
    assetCheck: store.makeAssetChecker(osDir),
    verdictCounts,
    floor: floor !== undefined ? floor : 0.7,
    staleMs: (staleAfterDays || 7) * 86400000,
    nowMs: now ? Date.parse(now) : Date.now(),
  };

  // Required Intelligence = goalからrequires/depends_onで到達する全ノード（goal自身は除く）
  const reached = traverseGraph(snapshot, root, { kinds: REQUIRE_KINDS, direction: 'out', depth, limit: 200 });
  const required = reached.filter((r) => r.id !== root).map((node) => {
    const c = classifyNode(node, ctx);
    return {
      id: node.id,
      type: node.type,
      body: node.body,
      depth: node.depth,
      classification: c.classification,
      why: c.why,
      bindings: c.bindings.map((e) => `${e.kind} -> ${e.to}（${e.via}）`),
    };
  });
  required.push(...goalCriteriaGaps(osDir, verdictCounts));

  const summary = {};
  for (const c of CLASSIFICATIONS) summary[c] = required.filter((r) => r.classification === c).length;
  const nextActions = {};
  for (const [cls, action] of Object.entries(NEXT_ACTIONS)) {
    if (summary[cls]) nextActions[cls] = action;
  }
  return {
    goal: root,
    goal_body: snapshot.statements[root].body,
    required_total: required.length,
    summary,
    required,
    next_actions: nextActions,
  };
}

// --assert: MISSINGをUnknownノードとして起票する（§13 Unknownの第一級化）。
// idは内容ハッシュ由来で冪等 — 同じGapを二重起票しない。
function assertMissingAsUnknowns(osDir, analysis) {
  const statements = [];
  for (const r of analysis.required) {
    if (r.classification !== 'MISSING') continue;
    const st = {
      id: `gap-${sha1(`${analysis.goal}\n${r.id}\nMISSING`).slice(0, 10)}`,
      ts: nowIso(),
      type: 'unknown',
      body: `Gap(MISSING): goal ${analysis.goal} の達成に必要な「${r.body}」（${r.id}）が接地していない — ${r.why}`,
      status: 'unknown',
      tags: ['gap'],
      provenance: { source: 'gap-analysis', method: 'deterministic' },
    };
    if (analysis.goal && r.id && !r.id.includes(':')) {
      st.links = [{ role: 'about', to: r.id }];
    }
    statements.push(st);
  }
  if (!statements.length) return { added: [], skipped: [] };
  return store.assertStatements(osDir, statements);
}

module.exports = { gapAnalysis, assertMissingAsUnknowns, classifyNode, CLASSIFICATIONS };
