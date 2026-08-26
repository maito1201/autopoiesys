'use strict';
// 宣言的Queryエンジン。World Model全体をLLMに渡す経路を作らないための唯一のアクセス面。
// max_tokens はここで強制される（設計原則§26⑤）。
const fs = require('node:fs');
const path = require('node:path');
const { getSnapshot } = require('./store');
const { estimateTokens, appendJsonl, nowIso, stableStringify, readTextFile } = require('./util');
const { parseYaml } = require('./yaml');

const PIPELINE_STEPS = ['select', 'where', 'where_param', 'expand', 'sort', 'project', 'limit'];
const DEFAULT_MAX_TOKENS = 2000;

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
      const val = params[paramName];
      if (val !== undefined && val !== null && val !== '') {
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
function runQuery(osDir, name, params = {}, { maxTokens, offset = 0 } = {}) {
  const def = loadQueryDef(osDir, name);
  if (def.params) {
    for (const [p, spec] of Object.entries(def.params)) {
      if (spec && spec.required && (params[p] === undefined || params[p] === '')) {
        throw new Error(`必須パラメータ欠落: ${p}`);
      }
    }
  }
  const snapshot = getSnapshot(osDir);
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
  appendJsonl(path.join(osDir, 'observations', 'query_log.jsonl'), {
    ts: nowIso(),
    query: name,
    params,
    count: results.length,
    total,
    truncated,
    tokens_est: used,
  });
  return out;
}

module.exports = { runQuery, loadQueryDef, listQueries, validateQueryDef, PIPELINE_STEPS };
