'use strict';
// Decision Model（CONCEPT §8）の最小実装。
// 「OSは情報を保存するだけではいけない」— 決定を選択肢・基準・期待結果・レビュー期限を持つ
// 構造として残し、期限後に結果を照合するループを閉じる。
// 保存層は作らない: 既存の world_model/events.jsonl（store.assertStatements）に追記する。
// レビュー結果は元のdecisionをsupersedeせず、type: outcome の新Statementを追記して
// links の derived_from で元へ張る（追記専用: 決定の記録そのものは書き換えない）。
const store = require('./store');

const OUTCOME_RESULTS = ['met', 'unmet', 'unclear'];

// review_after は「日付」または「イベント名」を取りうる（CONCEPT §8 / TODO C1）。
// 日付として解釈できるものだけが期限切れ判定の対象になり、イベント指定は人が判断する。
function parseWhen(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function assertStringArray(v, label) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error(`${label}は空でない文字列の配列`);
  }
  return v;
}

// 決定を1件記録する。CLI `decision new "<何を決めたか>" --options a,b --chosen a ...` の実体。
function newDecision(osDir, body, opts = {}) {
  if (!body || typeof body !== 'string' || !body.trim()) throw new Error('bodyが必要（何を決めたか）');
  const options = assertStringArray(opts.options, 'options');
  const criteria = assertStringArray(opts.criteria, 'criteria');
  const tags = assertStringArray(opts.tags, 'tags');
  const scope = assertStringArray(opts.scope, 'scope');
  const { chosen, expected_outcome: expectedOutcome, review_after: reviewAfter } = opts;
  for (const [k, v] of [['chosen', chosen], ['expected_outcome', expectedOutcome], ['review_after', reviewAfter]]) {
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) throw new Error(`${k}は空でない文字列`);
  }
  // 選択肢を列挙したのに選んだ手がその中に無いのは、記録漏れかtypoのどちらか。
  // 後から「何を捨てたか」を辿れなくなるので、書き込む前に落とす。
  if (options && chosen && !options.includes(chosen)) {
    throw new Error(`chosen "${chosen}" が options に含まれない（options: ${options.join(', ')}）`);
  }
  const st = {
    type: 'decision',
    body,
    status: 'fact',
    options,
    chosen,
    criteria,
    expected_outcome: expectedOutcome,
    review_after: reviewAfter,
    tags,
    scope,
    provenance: { source: opts.source || 'decision', method: opts.method || 'human' },
  };
  if (opts.task) st.provenance.task = opts.task;
  for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
  const r = store.assertStatements(osDir, [st]);
  return { id: r.added[0], statement: st, warnings: r.warnings };
}

// 決定ごとの最新outcome（現在状態にあるもの）を引く索引を作る
function outcomeIndex(snap) {
  const byDecision = {};
  for (const id of Object.keys(snap.statements).sort()) {
    const st = snap.statements[id];
    if (st.type !== 'outcome') continue;
    for (const l of st.links || []) {
      if (l.role !== 'derived_from') continue;
      const target = snap.statements[l.to];
      if (!target || target.type !== 'decision') continue;
      (byDecision[l.to] = byDecision[l.to] || []).push(st);
    }
  }
  for (const k of Object.keys(byDecision)) {
    // 同じ決定を再レビューした場合は最新（ts→id）を現在の判定とする
    byDecision[k].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  }
  return byDecision;
}

// 決定一覧。due: true のときは review_after を過ぎていて未レビューのものだけ返す。
function listDecisions(osDir, { due = false, now } = {}) {
  const snap = store.getSnapshot(osDir);
  const outcomes = outcomeIndex(snap);
  const nowMs = now ? Date.parse(now) : Date.now();
  const ids = (snap.indexes.by_type && snap.indexes.by_type.decision) || [];
  const rows = ids.map((id) => {
    const st = snap.statements[id];
    const found = outcomes[id] || [];
    const outcome = found.length ? found[found.length - 1] : null;
    const dueMs = parseWhen(st.review_after);
    return {
      ...st,
      outcome: outcome ? { id: outcome.id, ts: outcome.ts, result: outcome.result, note: outcome.note } : null,
      reviewed: Boolean(outcome),
      // 期限がイベント指定（日付として読めない）なら時間では判定しない
      overdue: dueMs !== null && dueMs <= nowMs,
      review_after_ms: dueMs,
    };
  });
  const filtered = due ? rows.filter((r) => r.overdue && !r.reviewed) : rows;
  return filtered.sort((a, b) => {
    const av = a.review_after_ms === null ? Infinity : a.review_after_ms;
    const bv = b.review_after_ms === null ? Infinity : b.review_after_ms;
    if (av !== bv) return av - bv;
    return a.id < b.id ? -1 : 1;
  });
}

// レビュー結果を記録する。元のdecisionはsupersedeせず、outcomeを追記してderived_fromで張る。
function recordOutcome(osDir, id, { result, note, source, method, task } = {}) {
  if (!OUTCOME_RESULTS.includes(result)) throw new Error(`resultは ${OUTCOME_RESULTS.join('|')}`);
  if (note !== undefined && typeof note !== 'string') throw new Error('noteは文字列');
  const snap = store.getSnapshot(osDir);
  const decision = snap.statements[id];
  if (!decision) throw new Error(`decisionが現在状態に存在しない（既に置換済みか、id誤り）: ${id}`);
  if (decision.type !== 'decision') throw new Error(`${id} はtype: decisionではない（${decision.type}）`);
  const prevList = outcomeIndex(snap)[id] || [];
  const previous = prevList.length ? prevList[prevList.length - 1] : null;
  const st = {
    type: 'outcome',
    body: note ? `決定「${decision.body}」の結果: ${result} — ${note}` : `決定「${decision.body}」の結果: ${result}`,
    status: 'fact',
    result,
    note,
    decision: id,
    links: [{ role: 'derived_from', to: id }],
    tags: decision.tags,
    scope: decision.scope,
    provenance: { source: source || 'decision-review', method: method || 'human' },
  };
  if (task) st.provenance.task = task;
  for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
  const r = store.assertStatements(osDir, [st]);
  const out = {
    id: r.added[0],
    decision: id,
    result,
    warnings: r.warnings,
    suggest_feedback: false,
  };
  if (previous) out.previous_outcome = { id: previous.id, result: previous.result };
  // 期待どおりにならなかった決定は、記録して終わらせない。Failureループへ渡す（§26④）。
  if (result === 'unmet') {
    out.suggest_feedback = true;
    out.message = `期待結果を満たさなかった決定（${id}）。ログで終わらせずFailureとして起票せよ: `
      + `autopoiesys feedback "${decision.body}: 期待した ${decision.expected_outcome || '結果'} にならなかった"`;
  }
  return out;
}

// レビュー期限切れの集計（運用ヒント用）。maintenanceHintsから中継できるよう文字列も返す。
function reviewSummary(osDir, { now } = {}) {
  const overdue = listDecisions(osDir, { due: true, now });
  const summary = {
    due: overdue.length,
    unreviewed_overdue: overdue.map((d) => {
      const row = {
        id: d.id,
        body: d.body,
        review_after: d.review_after,
        chosen: d.chosen,
        expected_outcome: d.expected_outcome,
      };
      // 未記入の欄を undefined のまま出すと、人向け出力に "undefined" が並ぶ
      for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
      return row;
    }),
    hints: [],
  };
  if (overdue.length) {
    summary.hints.push(
      `レビュー期限切れのdecisionが${overdue.length}件（${overdue.slice(0, 5).map((d) => d.id).join(', ')}`
      + `${overdue.length > 5 ? ' …' : ''}）: decision outcome <id> --result met|unmet|unclear で照合せよ`
    );
  }
  return summary;
}

module.exports = { OUTCOME_RESULTS, newDecision, listDecisions, recordOutcome, reviewSummary };
