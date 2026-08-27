'use strict';
// 宣言的Queryエンジン。World Model全体をLLMに渡す経路を作らないための唯一のアクセス面。
// max_tokens はここで強制される（設計原則§26⑤）。
const fs = require('node:fs');
const path = require('node:path');
const { getSnapshot } = require('./store');
const { estimateTokens, appendJsonl, nowIso, stableStringify, readTextFile } = require('./util');
const { parseYaml } = require('./yaml');

const PIPELINE_STEPS = ['select', 'where', 'where_param', 'expand', 'sort', 'project', 'limit', 'traverse'];
const DEFAULT_MAX_TOKENS = 2000;
const TRAVERSE_MAX_DEPTH = 8;

// 統合辺索引（edges_out/edges_in）上の決定的BFS。到達ノードを rows として返す。
// 各行に depth と path（経由辺の列）が付く — path が Reasoning Path の実体（CONCEPTv2 §8）。
function traverseGraph(snapshot, startId, { kinds, direction, depth, limit }) {
  const edgesOut = snapshot.indexes.edges_out || {};
  const edgesIn = snapshot.indexes.edges_in || {};
  const visited = new Set([startId]);
  const rows = [];
  const toRow = (id, d, pathArr) => {
    const st = snapshot.statements[id];
    const row = st ? { ...st } : { id, type: 'ref', body: id, status: 'fact' };
    row.depth = d;
    row.path = pathArr;
    return row;
  };
  rows.push(toRow(startId, 0, []));
  let frontier = [{ id: startId, path: [] }];
  for (let d = 1; d <= Math.min(depth, TRAVERSE_MAX_DEPTH) && frontier.length; d++) {
    const nextFrontier = [];
    for (const { id, path: pathArr } of frontier) {
      const candidates = [];
      if (direction === 'out' || direction === 'both') {
        for (const e of edgesOut[id] || []) candidates.push({ next: e.to, e });
      }
      if (direction === 'in' || direction === 'both') {
        for (const e of edgesIn[id] || []) candidates.push({ next: e.from, e });
      }
      // 決定的順序: 到達先id → 辺種 → 経由idでソート
      candidates.sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : a.e.kind < b.e.kind ? -1 : a.e.kind > b.e.kind ? 1 : a.e.via < b.e.via ? -1 : 1));
      for (const { next, e } of candidates) {
        if (kinds && !kinds.includes(e.kind)) continue;
        if (visited.has(next)) continue;
        visited.add(next);
        const step = { kind: e.kind, via: e.via, from: e.from, to: e.to };
        const newPath = [...pathArr, step];
        rows.push(toRow(next, d, newPath));
        nextFrontier.push({ id: next, path: newPath });
        if (rows.length >= limit) return rows;
      }
    }
    frontier = nextFrontier;
  }
  return rows;
}

function queryDir(osDir) {
  return path.join(osDir, 'queries');
}

function loadQueryDef(osDir, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`不正なQuery名: ${name}`);
  const file = path.join(queryDir(osDir), `${name}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`Queryが存在しない: ${name}（${file}）`);
  const def = parseYaml(readTextFile(file));
  const errors = validateQueryDef(def);
  if (errors.length) throw new Error(`Query定義エラー ${name}:\n  ${errors.join('\n  ')}`);
  // 大文字小文字非区別FSでの黙った不一致を防ぐ（loadEvaluatorDefと同じ理由）
  if (def.name !== name) {
    throw new Error(`Query名と定義内nameが不一致: 要求=${name} 定義=${def.name}（大文字小文字も区別される）`);
  }
  return def;
}

function listQueries(osDir) {
  const dir = queryDir(osDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')).sort();
}

function validateQueryDef(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['Query定義がオブジェクトでない'];
  if (!def.name) errors.push('name欠落');
  if (!def.description) errors.push('description欠落');
  if (!Array.isArray(def.pipeline) || def.pipeline.length === 0) {
    errors.push('pipelineは1ステップ以上の配列');
    return errors;
  }
  for (const step of def.pipeline) {
    const keys = Object.keys(step || {});
    if (keys.length !== 1) {
      errors.push(`pipelineステップは単一キー: ${stableStringify(step)}`);
      continue;
    }
    if (!PIPELINE_STEPS.includes(keys[0])) errors.push(`未知のpipelineステップ: ${keys[0]}（対応: ${PIPELINE_STEPS.join(', ')}）`);
  }
  if (def.max_tokens !== undefined && (typeof def.max_tokens !== 'number' || def.max_tokens <= 0)) {
    errors.push('max_tokensは正の数値');
  }
  return errors;
}

function matchField(st, field, cond) {
  const value = st[field];
  const conds = Array.isArray(cond) ? cond : [cond];
  if (Array.isArray(value)) return conds.some((c) => value.includes(c));
  return conds.includes(value);
}

// pipelineを実行して行集合を返す（トークン強制の前段）
function execPipeline(snapshot, pipeline, params) {
  let rows = Object.keys(snapshot.statements).sort().map((id) => ({ ...snapshot.statements[id] }));
  let total = null; // limitステップ直前の件数。limitが無いpipelineでは最終件数
  for (const step of pipeline) {
    const [op] = Object.keys(step);
    const arg = step[op];
    if (op === 'select' || op === 'where') {
      for (const [field, cond] of Object.entries(arg)) {
        rows = rows.filter((r) => matchField(r, field, cond));
      }
    } else if (op === 'where_param') {
      const paramName = arg.contains || arg.equals;
      let val = params[paramName];
      if (val !== undefined && val !== null && val !== '') {
        // カンマ区切りはOR条件（例: tag=billing,test）。tag等の値自体には
        // カンマが現れない前提（CLIの--tagsもカンマを区切りとして扱う）
        if (typeof val === 'string' && val.includes(',')) {
          val = val.split(',').map((s) => s.trim()).filter(Boolean);
        }
        rows = rows.filter((r) => matchField(r, arg.field, val));
      }
    } else if (op === 'expand') {
      const roles = arg.roles || null;
      const direction = arg.direction || 'both';
      const limit = arg.limit || 5;
      for (const r of rows) {
        const linked = [];
        if (direction === 'out' || direction === 'both') {
          for (const l of r.links || []) {
            if (roles && !roles.includes(l.role)) continue;
            const t = snapshot.statements[l.to];
            if (t) linked.push({ id: t.id, role: l.role, direction: 'out', type: t.type, body: t.body, status: t.status });
          }
        }
        if (direction === 'in' || direction === 'both') {
          for (const l of snapshot.indexes.links_in[r.id] || []) {
            if (roles && !roles.includes(l.role)) continue;
            const t = snapshot.statements[l.from];
            if (t) linked.push({ id: t.id, role: l.role, direction: 'in', type: t.type, body: t.body, status: t.status });
          }
        }
        r.linked = linked.slice(0, limit);
      }
    } else if (op === 'traverse') {
      // rowsを置き換える起点つき多段走査。起点は from（固定id）または from_param（実行時パラメータ）
      const startId = arg.from !== undefined ? String(arg.from)
        : (arg.from_param ? params[arg.from_param] : undefined);
      if (!startId) throw new Error('traverse: from または from_param の値が必要');
      if (!snapshot.statements[String(startId)]) {
        throw new Error(`traverse: 起点が現在状態に存在しない: ${startId}`);
      }
      rows = traverseGraph(snapshot, String(startId), {
        kinds: arg.kinds || null,
        direction: arg.direction || 'out',
        depth: arg.depth || 3,
        limit: arg.limit || 50,
      });
    } else if (op === 'sort') {
      const by = arg.by || 'id';
      const desc = (arg.order || 'asc') === 'desc';
      rows.sort((a, b) => {
        const av = a[by];
        const bv = b[by];
        if (av === undefined && bv === undefined) return a.id < b.id ? -1 : 1;
        if (av === undefined) return 1; // 欠損は常に末尾
        if (bv === undefined) return -1;
        if (av < bv) return desc ? 1 : -1;
        if (av > bv) return desc ? -1 : 1;
        return a.id < b.id ? -1 : 1; // 安定した決定的順序
      });
    } else if (op === 'project') {
      rows = rows.map((r) => {
        const o = {};
        for (const f of arg) if (r[f] !== undefined) o[f] = r[f];
        return o;
      });
    } else if (op === 'limit') {
      total = rows.length;
      rows = rows.slice(0, arg);
    }
  }
  if (total === null) total = rows.length;
  return { rows, total };
}

// Query実行の唯一の入口。max_tokensで切詰め、実行をquery_log.jsonlに記録する。
// snapshot / log は監査（auditReachability）用: 同一snapshotを共有し、監査の空振りで
// query_log.jsonl を汚さないためにログを止められるようにしている。
function runQuery(osDir, name, params = {}, { maxTokens, offset = 0, snapshot: preloaded, log = true } = {}) {
  const def = loadQueryDef(osDir, name);
  if (def.params) {
    for (const [p, spec] of Object.entries(def.params)) {
      if (spec && spec.required && (params[p] === undefined || params[p] === '')) {
        throw new Error(`必須パラメータ欠落: ${p}`);
      }
    }
  }
  const snapshot = preloaded || getSnapshot(osDir);
  const { rows, total } = execPipeline(snapshot, def.pipeline, params);
  const budget = maxTokens || def.max_tokens || DEFAULT_MAX_TOKENS;
  const paged = rows.slice(offset);
  const results = [];
  let used = estimateTokens(stableStringify({ query: name, params, count: 0, total, truncated: false }));
  let truncated = false;
  for (const r of paged) {
    const cost = estimateTokens(stableStringify(r)) + 1;
    if (used + cost > budget && results.length > 0) {
      truncated = true;
      break;
    }
    if (used + cost > budget && results.length === 0) {
      // 1件も入らない場合でも最低1件は返す（budget極小時の空回り防止）が、切詰めは明示する
      results.push(r);
      used += cost;
      truncated = paged.length > 1;
      break;
    }
    results.push(r);
    used += cost;
  }
  if (offset + results.length < rows.length) truncated = true;
  const out = {
    query: name,
    params,
    count: results.length,
    total,
    truncated,
    results,
  };
  if (truncated) out.next_offset = offset + results.length;
  if (log) {
    appendJsonl(path.join(osDir, 'observations', 'query_log.jsonl'), {
      ts: nowIso(),
      query: name,
      params,
      count: results.length,
      total,
      truncated,
      tokens_est: used,
    });
  }
  return out;
}


// ---- 到達性監査（⑤到達の機械化）----------------------------------------------------
// 「引けない事実は運用上存在しないのと等価」である。取り込んだ知識がQueryの返却枠に実際に入るかは
// Query設計者のセンスに委ねられており、孤児タグ（どのQueryのフィルタにも掛からない）と
// 静かな切り捨て（一致件数 > limit / max_tokens）は誰も検出しなかった。ここで決定的に検出する。
//
// 必須paramの候補値は「World Modelに実在する値」から導く（where_paramが参照するフィールドの
// 実在値）。語彙表ではなく実データから採るため、登録漏れの語彙でも監査が効く。
function auditReachability(osDir, { maxCombos = 500, maxRunsPerQuery = 4000, maxPages = 20 } = {}) {
  const snapshot = getSnapshot(osDir);
  const names = listQueries(osDir);
  const allIds = Object.keys(snapshot.statements);
  const statements = Object.values(snapshot.statements);
  const reached = new Set();
  const truncating = [];
  const defects = [];

  const valuesOfField = (field) => {
    const vals = new Set();
    for (const st of statements) {
      const v = st[field];
      if (Array.isArray(v)) v.forEach((x) => vals.add(x));
      else if (v !== undefined && v !== null && v !== '') vals.add(v);
    }
    return [...vals].sort();
  };

  for (const name of names) {
    let def;
    try {
      def = loadQueryDef(osDir, name);
    } catch (e) {
      defects.push(`${name}: 定義エラーのため監査不能（${e.message.split('\n')[0]}）`);
      continue;
    }
    const projected = def.pipeline.filter((st) => st.project).map((st) => st.project);
    if (projected.length && !projected.every((fields) => fields.includes('id'))) {
      // idを返さないQueryは引用の裏取りも到達性監査もできない（存在しない事実の引用事故の温床）
      defects.push(`${name}: projectにidが無く、到達性を監査できない`);
      continue;
    }
    // paramの候補値はWorld Modelの実在値から導く（語彙表ではなく実データなので登録漏れでも効く）
    const fieldOfParam = {};
    for (const step of def.pipeline) {
      if (step.where_param) fieldOfParam[step.where_param.contains || step.where_param.equals] = step.where_param.field;
    }
    const params = Object.entries(def.params || {});
    const required = params.filter(([, spec]) => spec && spec.required).map(([p]) => p);
    const optional = params.filter(([, spec]) => !spec || !spec.required).map(([p]) => p);

    // 必須paramは組み合わせ（積）を全部試す。実行先が決まらないと1件も引けないため
    let combos = [{}];
    let capped = false;
    const fieldUsedBy = {};
    for (const p of required) {
      const field = fieldOfParam[p];
      const values = field ? valuesOfField(field) : [];
      if (!values.length) {
        defects.push(`${name}: 必須param ${p} の候補値をWorld Modelから導出できない（where_paramで消費されていないか、値が存在しない）`);
        combos = [];
        break;
      }
      // 同じフィールドを2つのparamで絞るQuery（例: repo_a×repo_b）で同値の組を作らない。
      // 「同じリポジトリを2回指定」は退化した呼び出しであり、監査の対象にすると偽の切り捨てを生む
      const sameField = fieldUsedBy[field] || [];
      const next = [];
      for (const c of combos) {
        for (const v of values) {
          if (sameField.some((prev) => c[prev] === v)) continue;
          next.push({ ...c, [p]: v });
        }
      }
      fieldUsedBy[field] = [...sameField, p];
      if (next.length > maxCombos) {
        capped = true;
        combos = next.slice(0, maxCombos);
      } else {
        combos = next;
      }
    }
    if (capped) defects.push(`${name}: 必須paramの組み合わせが${maxCombos}件を超えるため完全監査できない`);

    // 任意paramは「無し」と「1つだけ指定」を試す（積を全部試すと組み合わせ爆発する。
    // 絞り込みを足すほど一致は狭まるので、単独指定でも到達可能性の大半は測れる）
    const withOptionals = [];
    for (const c of combos) {
      withOptionals.push(c);
      for (const p of optional) {
        for (const v of valuesOfField(fieldOfParam[p] || p)) withOptionals.push({ ...c, [p]: v });
      }
    }
    if (withOptionals.length > maxRunsPerQuery) {
      defects.push(`${name}: 試行数が${maxRunsPerQuery}件を超えるため完全監査できない`);
    }
    for (const p of withOptionals.slice(0, maxRunsPerQuery)) {
      // max_tokensによる切り詰めは next_offset で追える（呼び出し側の義務）。到達性の判定では
      // ページングで追い切れるかを見る。追ってもなお出てこない事実は limit ステップに阻まれており、
      // どう呼び出しても返らない＝運用上存在しない
      let offset = 0;
      let pages = 0;
      let first = null;
      for (;;) {
        const r = runQuery(osDir, name, p, { snapshot, log: false, offset });
        if (!first) first = r;
        for (const row of r.results) if (row.id) reached.add(row.id);
        pages += 1;
        if (r.next_offset === undefined || pages >= maxPages || r.results.length === 0) break;
        offset = r.next_offset;
      }
      if (first && first.total > first.count) {
        truncating.push({ query: name, params: p, total: first.total, count: first.count });
      }
    }
  }
  const unreachable = allIds.filter((id) => !reached.has(id)).sort();
  // 違反は「到達不能」と「監査不能」に限る。max_tokensによる切り詰めはページングで追えるので
  // 設計（§26⑤）どおりであり、追ってもなお返らないもの（limitに阻まれた事実）だけを違反とする。
  return {
    statement_count: allIds.length,
    query_count: names.length,
    reached: reached.size,
    unreachable,
    truncating,
    defects,
    violations: unreachable.length + defects.length,
  };
}

module.exports = { runQuery, auditReachability, loadQueryDef, listQueries, validateQueryDef, traverseGraph, PIPELINE_STEPS };
