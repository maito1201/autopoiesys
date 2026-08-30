'use strict';
// Decision Model（CONCEPT §8）。**支援対象はAI自身であって人間ではない。**
//
// 第1版は人間向けの帳簿だった（レビュー期限という日付を持ち、期限切れをCLI出力で
// 催促する）。カレンダー上の日付は人間の道具であり、AIの判断の契機ではない。
// AIにとっての契機は**再来**である — 同じ判断の場にもう一度立った瞬間に、
// 前回何を選び、何を捨て、結果がどうだったかが出てくること。
//
// したがってここでは:
//   - 決定は situation（判断の場）と fingerprint を持ち、記録しようとした瞬間に
//     コアが過去を突き返す（recall）。読むかどうかを実行者の判断に委ねない
//   - 前回の結果が未記録のまま同じ場に来たら、その場で埋めろと言う（期限では催促しない）
//   - 反復して結果が伴った決定は policy.js が方針へ畳み込み、以後は推論なしで発火する
//
// 保存層は作らない: 既存の world_model/events.jsonl に追記する。
// レビュー結果は元のdecisionをsupersedeせず、type: outcome の新Statementを追記して
// links の derived_from で元へ張る（追記専用: 決定の記録そのものは書き換えない）。
const store = require('./store');
const policy = require('./policy');

const OUTCOME_RESULTS = ['met', 'unmet', 'unclear'];

function assertStringArray(v, label) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error(`${label}は空でない文字列の配列`);
  }
  return v;
}

// 近傍照合の上限と閾値。situationは書き手の自由文なので、同じ場でも語が揺れれば
// fingerprintは一致しない（実測: 6件の決定はすべて別fingerprintで、再来が一度も起きなかった）。
// 完全一致の意味は変えずに、語が重なる場を「近い場」として併せて返す。
const NEAR_LIMIT = 5;
// 語の重なりで「近い場」と呼ぶ最小の一致数。situationは「〜を選ぶ」「〜の決め方」のような
// 共通の枠を持つため、1件の重なりで近いと言うと全部が近くなる。実測: 無関係な
// 「コーヒー豆の焙煎度合いを選ぶ」と「ジョブキューの実装方式を選ぶ」の重なりは
// 枠だけの2件（を選 / 選ぶ）、実際に近い「ジョブキューの監視方式を選ぶ」は10件。
// context.js の TERM_MATCH_MIN と同じ理由で同じ値を採る（緩めると近傍が意味を失う）。
const NEAR_MIN_HITS = 3;

// situationの語が重なる、別fingerprintの決定。関連度（語一致数）→id で決定的に並べる。
function nearbyDecisions(osDir, situation, excludeFp, byFp) {
  if (!situation) return [];
  const { extractTerms } = require('./context'); // 語の切り方だけ借りる（context.jsは編集しない）
  const terms = [...extractTerms(situation)];
  if (!terms.length) return [];
  const rows = [];
  for (const fpKey of Object.keys(byFp).sort()) {
    if (fpKey === excludeFp) continue;
    const b = byFp[fpKey];
    const s = String(b.situation || '').toLowerCase();
    const hits = terms.filter((t) => s.includes(t)).length;
    if (hits < NEAR_MIN_HITS) continue;
    for (const d of b.decisions) {
      rows.push({
        id: d.id,
        fingerprint: fpKey,
        situation: b.situation,
        chosen: d.chosen,
        latest_result: d.latest_result,
        hits,
      });
    }
  }
  rows.sort((a, b) => (b.hits - a.hits) || (a.id < b.id ? -1 : 1));
  return rows.slice(0, NEAR_LIMIT);
}

// 同じ判断の場の過去。決定を書く前にも、方針を引く前にも、これを通る。
function recall(osDir, { situation, options, fingerprint: fp } = {}) {
  const key = fp || policy.situationFingerprint(situation);
  const byFp = policy.foldByFingerprint(osDir);
  const bucket = byFp[key];
  const prior = bucket ? bucket.decisions : [];
  // fingerprintだけで引かれた場合でも、台帳側にsituationがあれば近傍照合に使える
  const near = nearbyDecisions(osDir, situation || (bucket && bucket.situation), key, byFp);
  const unreviewed = prior.filter((d) => !d.outcomes.length);
  const messages = [];
  for (const d of prior) {
    const r = d.latest_result;
    messages.push(
      `前回（${d.id}）はこの場で「${d.chosen || '(未記録)'}」を選んだ` +
      (r ? `。結果: ${r}` : '。**結果が未記録**')
    );
  }
  // 期限ではなく再来で催促する。同じ判断にもう一度立った今が、前回の答え合わせに
  // 一番意味がある瞬間である（カレンダー上の日付には意味がない）。
  if (unreviewed.length) {
    messages.push(
      `この判断の場には結果が未記録の決定が${unreviewed.length}件ある（` +
      `${unreviewed.map((d) => d.id).join(', ')}）。` +
      '同じ場に戻ってきた今が答え合わせの時である: ' +
      `node cli/index.js decision outcome <id> --result met|unmet|unclear`
    );
  }
  // 完全一致が無いときこそ近傍が効く。「初めての場だ」と思って考え直す前に、
  // 語が重なる過去の場を見せる — 場の切り方が細かすぎて再来しないことは、
  // 経験が無いことを意味しない
  if (near.length) {
    messages.push(
      `完全に同じ場ではないが、語が重なる過去の決定が${near.length}件ある: ` +
      near.map((n) => `${n.id}「${n.situation}」→ ${n.chosen || '(未記録)'}` +
        `（結果: ${n.latest_result || '未記録'}）`).join(' / ')
    );
    if (!prior.length) {
      messages.push(
        '同じ場として扱うなら --situation を近傍に合わせて書くこと（fingerprintが一致して初めて畳み込みの対象になる）'
      );
    }
  }
  const hit = policy.match(osDir, { fingerprint: key, log: false });
  return {
    fingerprint: key,
    prior,
    near,
    unreviewed: unreviewed.map((d) => d.id),
    policy: hit.policy,
    messages,
  };
}

// 決定を1件記録する。書く前に必ず過去を突き返す。
function newDecision(osDir, body, opts = {}) {
  if (!body || typeof body !== 'string' || !body.trim()) throw new Error('bodyが必要（何を決めたか）');
  const options = assertStringArray(opts.options, 'options');
  const criteria = assertStringArray(opts.criteria, 'criteria');
  const tags = assertStringArray(opts.tags, 'tags');
  const scope = assertStringArray(opts.scope, 'scope');
  const { chosen, expected_outcome: expectedOutcome, situation } = opts;
  for (const [k, v] of [['chosen', chosen], ['expected_outcome', expectedOutcome], ['situation', situation]]) {
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) throw new Error(`${k}は空でない文字列`);
  }
  // situation が無いと判断の場を同定できず、再来しても一致しない。
  // 「何を選ぶ場面か」を1行で抽象化させることが、この層で唯一人（またはAI）に要求する仕事である。
  if (!situation) {
    throw new Error('--situation が必要（何を選ぶ場面かを1行で抽象化する。これが無いと同じ判断の再来を検出できない）');
  }
  // 選択肢を列挙したのに選んだ手がその中に無いのは、記録漏れかtypoのどちらか。
  // 後から「何を捨てたか」を辿れなくなるので、書き込む前に落とす。
  if (options && chosen && !options.includes(chosen)) {
    throw new Error(`chosen "${chosen}" が options に含まれない（options: ${options.join(', ')}）`);
  }
  const fingerprint = policy.situationFingerprint(situation);
  const before = recall(osDir, { fingerprint, situation });
  const st = {
    type: 'decision',
    body,
    status: 'fact',
    situation,
    fingerprint,
    options,
    chosen,
    criteria,
    expected_outcome: expectedOutcome,
    tags,
    scope,
    provenance: { source: opts.source || 'decision', method: opts.method || 'llm' },
  };
  if (opts.task) st.provenance.task = opts.task;
  for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
  const r = store.assertStatements(osDir, [st]);
  const out = { id: r.added[0], statement: st, warnings: r.warnings, recall: before };
  // 方針に反する選択をしたことは違反ではない。ただし黙って通さない —
  // 方針が現実と合わなくなった最初の兆候がここに出る。
  if (before.policy && chosen && before.policy.choose !== chosen) {
    out.contradicts_policy = {
      fingerprint,
      policy_choose: before.policy.choose,
      chosen,
      message:
        `確立済みの方針は「${before.policy.choose}」だが「${chosen}」を選んだ。` +
        '方針を破ること自体は違反ではないが、理由を残すこと。' +
        `結果が unmet なら方針は自動撤回される`,
    };
  }
  // コンパイル条件を満たしたら、この決定を書いた時点で畳み込む。
  // 「あとでコンパイルする」経路にすると、誰も走らせないまま資産化されない。
  const c = policy.compile(osDir, { fingerprint });
  if (c.compiled.length) {
    out.compiled_policy = c.compiled[0];
    out.message =
      `この判断の場は方針として確立した（${c.compiled[0].choose}）。` +
      '以後、同じ場では推論なしでこの選択が返る。unmet が1件出れば自動で撤回される';
  }
  return out;
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

// 決定一覧。unreviewed: true で結果が未記録のものだけ返す。
// 「期限切れ」という概念は持たない（日付はAIの判断の契機ではない）。
function listDecisions(osDir, { unreviewed = false } = {}) {
  const snap = store.getSnapshot(osDir);
  const outcomes = outcomeIndex(snap);
  const ids = (snap.indexes.by_type && snap.indexes.by_type.decision) || [];
  const rows = ids.map((id) => {
    const st = snap.statements[id];
    const found = outcomes[id] || [];
    const outcome = found.length ? found[found.length - 1] : null;
    return {
      ...st,
      outcome: outcome ? { id: outcome.id, ts: outcome.ts, result: outcome.result, note: outcome.note } : null,
      reviewed: Boolean(outcome),
    };
  });
  const filtered = unreviewed ? rows.filter((r) => !r.reviewed) : rows;
  return filtered.sort((a, b) => (a.id < b.id ? -1 : 1));
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
    provenance: { source: source || 'decision-review', method: method || 'llm' },
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
  // 場の鍵は畳み込み（読み出し）と同じ1本の規則で引く。記録済みの fingerprint を
  // 直に使うと、旧方式で記録された決定は unmet を出しても方針が撤回されない
  const key = policy.decisionKey(decision);
  if (result === 'unmet') {
    // 反証は裁量ではない。unmet が1件出た時点で方針の発火を止める。
    // 「例外はあるが方針は正しい」と言えてしまうと、方針は反証不能な信念になる。
    if (key) {
      const retracted = policy.retract(osDir, key, {
        by: out.id,
        reason: `決定 ${id} の結果が unmet（${note || '理由未記載'}）`,
      });
      if (retracted) {
        out.retracted_policy = retracted;
        out.message_policy =
          `方針「${retracted.situation} → ${retracted.choose}」を撤回した。` +
          'この判断の場は熟慮に戻る';
      }
    }
    // 期待どおりにならなかった決定は、記録して終わらせない。Failureループへ渡す（§26④）。
    out.suggest_feedback = true;
    out.message = `期待結果を満たさなかった決定（${id}）。ログで終わらせずFailureとして起票せよ: `
      + `autopoiesys feedback "${decision.body}: 期待した ${decision.expected_outcome || '結果'} にならなかった"`;
  } else if (result === 'met' && key) {
    // 反証は「方針どおりにやって外れた」だけではない。**方針に反する選択も met になった**なら、
    // その判断の場の切り方が現実と合っていない。どちらの選択も正しいなら、
    // 場を分ける条件が situation に書かれていないということである。
    const active = policy.getPolicy(osDir, key);
    if (active && active.status === 'active' && decision.chosen && active.choose !== decision.chosen) {
      const frozen = policy.retract(osDir, key, {
        by: out.id,
        reason: `方針は「${active.choose}」だが「${decision.chosen}」も met になった（判断の場の切り方が粗い）`,
        blockRecompile: true,
      });
      out.retracted_policy = frozen;
      out.message_policy =
        `方針「${frozen.situation} → ${frozen.choose}」を撤回し、この判断の場を凍結した。` +
        'どちらの選択も met になるなら、場を分ける条件が situation に書かれていない。' +
        'situationを切り直してから決定を積み直すこと';
    } else {
      // 結果が伴った時点でコンパイル条件を再評価する（畳み込みの契機は結果の記録側にもある）
      const c = policy.compile(osDir, { fingerprint: key });
      if (c.compiled.length) {
        out.compiled_policy = c.compiled[0];
        out.message_policy =
          `この判断の場は方針として確立した（${c.compiled[0].choose}）。以後は推論なしで発火する`;
      }
    }
  }
  return out;
}

module.exports = { OUTCOME_RESULTS, newDecision, listDecisions, recordOutcome, recall };
