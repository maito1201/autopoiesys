'use strict';
// Reasoning Context（CONCEPTv2 §8）: 「目的に必要な最小Subgraph」を決定的に合成する。
// World Model全体でもQuery結果の全文でもなく、taskとevaluatorに関連するStatementだけを
// 関連度順に並べ、トークン予算内で切る。関連度は数えられる指標（Query一致・タグ一致数・
// 語の一致数・link数）だけで決まる — ここでLLMを呼ばないことが要件である
// （呼ぶと「文脈を絞るためのコスト」が「絞られた文脈のコスト」を上回りうる）。
const { getSnapshot } = require('./store');
const { runQuery } = require('./query');
const { estimateTokens } = require('./util');

// 1ホップ展開に使うlink role。supports/counters/derived_from は「その主張が
// 立つ/崩れる根拠」であり、判定に効く。relates_to/about は話題の隣接でしかないため広げない。
const HOP_ROLES = ['supports', 'counters', 'derived_from'];
const DEFAULT_MAX_TOKENS = 1500;
const TERM_MATCH_MIN = 3;
const BODY_LIMIT = 320;
const MAX_TERMS = 400;
const MAX_HOP_LINKS_SHOWN = 3;

// 語の一致だけで拾うと文脈が薄まる高頻度語。決定的に固定した最小限の除外リスト。
const STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'are', 'was',
  'md', 'js', 'json', 'yaml', 'src', 'lib', 'docs', 'test', 'tests',
  'する', 'した', 'して', 'こと', 'ため', 'もの', 'この', 'その', 'ある', 'いる',
  'れる', 'られ', 'てい', 'から', 'まで', 'よう', 'なる', 'った',
]);

// 日本語には語境界が無いため、ASCII語とCJK連続の2-gramの双方を「語」として扱う。
// 形態素解析器（外部依存）を使わずに決定的な一致を取るための割り切り。
function extractTerms(text) {
  const terms = new Set();
  const lower = String(text || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]{3,}/g)) {
    if (!STOP_TERMS.has(m[0])) terms.add(m[0]);
    if (terms.size >= MAX_TERMS) return terms;
  }
  for (const run of lower.matchAll(/[぀-ヿ㐀-鿿豈-﫿]{2,}/g)) {
    const s = run[0];
    for (let i = 0; i + 2 <= s.length; i++) {
      const g = s.slice(i, i + 2);
      if (!STOP_TERMS.has(g)) terms.add(g);
      if (terms.size >= MAX_TERMS) return terms;
    }
  }
  return terms;
}

// taskから語を採る対象: objective / artifactのパスとnote / 自由記述のcontext。
// 「何を作ろうとしているか」を表す語だけを使う（notesは作業ログでノイズが多いため使わない）。
function taskText(task) {
  if (!task) return '';
  const parts = [task.objective || ''];
  for (const a of task.artifacts || []) {
    parts.push(String((a && a.path) || ''));
    if (a && a.note) parts.push(String(a.note));
  }
  if (task.context) parts.push(String(task.context));
  return parts.join(' ');
}

function statementRow(snapshot, id, fallback) {
  const st = snapshot.statements[id];
  if (st) return st;
  return fallback || { id, type: 'ref', body: id, status: 'fact' };
}

// HOP_ROLES の辺だけを辿る1ホップ。統合辺索引（links[]とrelationshipの双方）を使う。
function hopNeighbors(snapshot, id) {
  const out = [];
  for (const e of (snapshot.indexes.edges_out || {})[id] || []) {
    if (HOP_ROLES.includes(e.kind)) out.push({ id: e.to, kind: e.kind, direction: 'out' });
  }
  for (const e of (snapshot.indexes.edges_in || {})[id] || []) {
    if (HOP_ROLES.includes(e.kind)) out.push({ id: e.from, kind: e.kind, direction: 'in' });
  }
  return out;
}

function degreeOf(snapshot, id) {
  const o = ((snapshot.indexes.edges_out || {})[id] || []).length;
  const i = ((snapshot.indexes.edges_in || {})[id] || []).length;
  return o + i;
}

function truncateBody(body) {
  const s = String(body === undefined ? '' : body).replace(/\s+/g, ' ').trim();
  return s.length > BODY_LIMIT ? `${s.slice(0, BODY_LIMIT)}…` : s;
}

function renderEntry(snapshot, entry) {
  const lines = [];
  const meta = [];
  if (entry.tags && entry.tags.length) meta.push(`tags: ${entry.tags.join(',')}`);
  if (entry.scope && entry.scope.length) meta.push(`scope: ${entry.scope.join(',')}`);
  meta.push(`選抜: ${entry.sources.join('+')}`);
  lines.push(`- ${entry.id} [${entry.type}/${entry.status}] ${truncateBody(entry.body)}`);
  lines.push(`  （${meta.join(' | ')}）`);
  const hops = hopNeighbors(snapshot, entry.id).slice(0, MAX_HOP_LINKS_SHOWN);
  for (const h of hops) {
    const t = snapshot.statements[h.id];
    lines.push(`  ${h.direction === 'out' ? '→' : '←'} ${h.kind} ${h.id}${t ? `: ${truncateBody(t.body).slice(0, 80)}` : ''}`);
  }
  return lines;
}

// task/evaluatorに関連するStatementを決定的に選抜し、maxTokens以内に切る。
// 返り値の lines がbriefingにそのまま埋まる本文、entries が選抜結果（テスト・実験用）。
function buildReasoningContext(osDir, { task, evaluator, maxTokens, snapshot: preloaded, queryParams } = {}) {
  const snapshot = preloaded || getSnapshot(osDir);
  let def = evaluator;
  if (typeof evaluator === 'string') {
    // 循環requireを避けるため遅延読込（evaluate.js → context.js の向きが正）
    def = require('./evaluate').loadEvaluatorDef(osDir, evaluator);
  }
  const budget = maxTokens || DEFAULT_MAX_TOKENS;
  const params = queryParams || {};
  const scored = {}; // id → {score, sources:Set}
  const queryErrors = [];
  const bump = (id, points, source) => {
    if (!id) return;
    const cur = (scored[id] = scored[id] || { score: 0, sources: new Set() });
    cur.score += points;
    cur.sources.add(source);
  };

  // (a) evaluatorのcontext_queries。Queryは既にmax_tokensで絞られた「引ける知識」であり、
  //     ここでは全文を埋めずidだけを採って関連度の種にする。
  const queriesUsed = [];
  for (const q of (def && def.context_queries) || []) {
    try {
      const res = runQuery(osDir, q, params);
      queriesUsed.push(q);
      for (const r of res.results) bump(r && r.id, 4, `query:${q}`);
    } catch (e) {
      queryErrors.push(`${q}: ${e.message}`);
    }
  }

  // (b) taskの語（objective・artifact）とStatementのtags/bodyの一致
  const terms = extractTerms(taskText(task));
  if (terms.size) {
    for (const id of Object.keys(snapshot.statements)) {
      const st = snapshot.statements[id];
      let tagHits = 0;
      for (const t of st.tags || []) {
        const tl = String(t).toLowerCase();
        if (terms.has(tl) || [...extractTerms(tl)].some((g) => terms.has(g))) tagHits++;
      }
      const body = String(st.body || '').toLowerCase();
      let bodyHits = 0;
      for (const t of terms) if (body.includes(t)) bodyHits++;
      const points = tagHits * 3 + Math.min(bodyHits, 5);
      // 2-gramは緩い一致器で、1〜2語の偶然の重なりは「関連」ではない。
      // 語だけで拾うにはTERM_MATCH_MIN以上の一致を要求する（タグ一致は1つで通す）。
      // ここを緩めるとWorld Model全体が予算いっぱいまで流れ込み、
      // 「最小Subgraph」が名ばかりになる（実測: 閾値なしでは旧方式より大きくなった）。
      if (tagHits > 0 || bodyHits >= TERM_MATCH_MIN) bump(id, points, tagHits ? 'tag一致' : '語一致');
    }
  }

  // (b') 同じタスク類型の教訓は、語が重ならなくても届ける。蒸留された経験は
  //      「この類型で効く」と宣言されているのだから、想起を語の偶然に任せない
  if (task && task.class_fp) {
    for (const id of Object.keys(snapshot.statements)) {
      const st = snapshot.statements[id];
      if (st.type === 'lesson' && st.task_class === task.class_fp) bump(id, 6, '同一類型の教訓');
    }
  }

  // (c) (a)(b)で得たStatementから1ホップ。反証（counters）は判定を覆しうるため
  //     支持（supports）より強く重み付けする — 都合の良い証拠だけが残る選抜を避ける。
  const seeds = Object.keys(scored).sort();
  const seedSet = new Set(seeds);
  for (const id of seeds) {
    for (const h of hopNeighbors(snapshot, id)) {
      if (seedSet.has(h.id)) continue; // 種そのものは1ホップとして加点しない
      bump(h.id, h.kind === 'counters' ? 3 : 2, `1ホップ:${h.kind}`);
    }
  }

  // link数（Graph上の中心性の粗い代理）。過大にならないよう上限2点。
  for (const id of Object.keys(scored)) {
    scored[id].score += Math.min(degreeOf(snapshot, id), 2);
  }

  const ranked = Object.keys(scored)
    .map((id) => {
      const st = statementRow(snapshot, id);
      return {
        id,
        score: scored[id].score,
        sources: [...scored[id].sources].sort(),
        type: st.type,
        status: st.status,
        body: st.body,
        tags: st.tags || [],
        scope: st.scope || [],
      };
    })
    // 関連度降順 → id昇順。同点でも順序が揺れない（briefingの再現性）
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));

  // 確立済みの方針を先頭に置く。過去の決定を畳み込んだもので、生成に推論を使っていない。
  // Statementの選抜より前に出すのは、これが「読むかどうか」を選ぶ材料ではなく
  // 判断の既定だからである（決定的な語一致で選ぶ。埋め込みもLLMも使わない）。
  const policyLines = require('./policy').policySection(osDir, [...extractTerms(taskText(task))]);

  const header = [...policyLines, '## Reasoning Context'];
  header.push('');
  header.push(
    '目的に関連するStatementだけを決定的に選抜した最小Subgraph'
    + `（選抜元: ${queriesUsed.length ? `Query=${queriesUsed.join(',')}` : 'Queryなし'}`
    + '、タスクの語との一致、そこから1ホップの supports/counters/derived_from'
    + `${params.scope ? `。scope=${params.scope} で絞り込み` : ''}）。`
  );
  header.push('ここに無い知識は「このタスクには関連しないと機械が判断した」ものである。');
  header.push('判定に足りなければ UNCERTAIN（reason: insufficient_evidence）とし、');
  header.push('不足している観点をevidenceに書け（Reasoning Contextの選抜規則の欠陥として扱う）。');
  header.push('');

  const lines = [...header];
  let used = estimateTokens(lines.join('\n'));
  const entries = [];
  let truncated = false;
  for (const e of ranked) {
    const block = renderEntry(snapshot, e);
    const cost = estimateTokens(block.join('\n')) + 1;
    if (used + cost > budget && entries.length > 0) {
      truncated = true;
      break;
    }
    lines.push(...block);
    entries.push(e);
    used += cost;
    if (used > budget) {
      truncated = ranked.length > entries.length;
      break;
    }
  }
  if (!entries.length) {
    lines.push('（関連するStatementは1件も選抜されなかった。World Modelにこのタスクの文脈が無い）');
    used = estimateTokens(lines.join('\n'));
  }
  if (truncated) {
    lines.push('');
    lines.push(`（関連度下位 ${ranked.length - entries.length} 件はトークン予算${budget}のため省略）`);
  }
  for (const err of queryErrors) lines.push(`（Query実行エラー: ${err}）`);
  lines.push('');

  return {
    lines,
    entries,
    candidates: ranked.length,
    truncated,
    tokens_est: estimateTokens(lines.join('\n')),
    max_tokens: budget,
    queries: queriesUsed,
    query_errors: queryErrors,
  };
}

// 実行側へ文脈を配る（CONCEPTv2 §8「Agentにはこのsubgraphだけを渡す」）。
// これまで Reasoning Context は llm_judge の briefing にしか流れておらず、
// 仕事をするAgent（特に会話履歴を持たないサブエージェント）に渡す手段が無かった。
// 判定者向けと同じ選抜装置を使い、渡す相手が実行側になっただけである。
// task は台帳のタスク（省略可）、purpose は「そのエージェントに今からさせること」。
function deliverContext(osDir, { task, purpose, queries, maxTokens, params } = {}) {
  if (!task && !purpose) throw new Error('--task または --purpose のどちらかが必要');
  // purposeはタスクの中の一場面を絞る語であり、objectiveと併せて関連度の種にする
  const seed = {
    id: (task && task.id) || 'ad-hoc',
    objective: [task && task.objective, purpose].filter(Boolean).join(' '),
    class_fp: task && task.class_fp,
    artifacts: (task && task.artifacts) || [],
    repo_dirs: (task && task.repo_dirs) || {},
  };
  const list = (queries || []).filter(Boolean);
  const r = buildReasoningContext(osDir, {
    task: seed,
    evaluator: list.length ? { id: 'context', context_queries: list } : undefined,
    maxTokens,
    queryParams: params || {},
  });
  // 判定者側（briefing）だけを測ると、トークン経済の実測が評価に偏る。
  // 実行側に配った文脈も同じ台帳に載せる
  try {
    const { appendJsonl, nowIso } = require('./util');
    appendJsonl(require('node:path').join(osDir, 'observations', 'context_log.jsonl'), {
      ts: nowIso(),
      kind: 'context',
      task: seed.id,
      purpose: purpose || null,
      entries: r.entries.length,
      tokens_est: r.tokens_est,
    });
  } catch {
    // 記録の失敗で文脈の配布そのものを止めない
  }
  return r;
}

module.exports = { buildReasoningContext, deliverContext, extractTerms, HOP_ROLES, DEFAULT_MAX_TOKENS };
