'use strict';
// 方針層（直感）。汎用モデル単体に無い「想起の保証」と「結果の書き戻し」を供給する。
//
// モデルは自分が何を想起できていないかを知らないので、想起を実行者の判断に委ねると
// 一番必要なときに一番落ちる。また自分の選択がうまくいったかを知る経路を持たないので、
// 外から書き戻さない限り同じ判断を毎回ゼロからやり直す。
//
// 人間が貧弱な脳でAIより良い判断をするのは、過去の知識と経験を抽象化して
// 再利用可能な思考様式にし、判断のたびに一から考え直さないからである。
// 機械側でこれに対応するのが「反復して結果が伴った決定を決定的な方針へ畳み込み、
// 以後は想起を強制すること」である。
//
// ここでの計算はハッシュ・索引・照合だけで、推論を経ないため非決定性が無い。
// **安いことは設計目標ではない** — 単価を目的に置くと小さなAIの再実装になる。
// 供給しているのは想起と書き戻しであって、節約ではない。
//
// **コアが決めるのは発火の条件と撤回の条件だけで、何を選ぶべきかではない。**
// どの選択が正しいかを焼き付けたら、それは前提を機械に固定する行為になる。
const fs = require('node:fs');
const path = require('node:path');
const { readTextFile, atomicWriteFile, nowIso, appendJsonl } = require('./util');
const { parseYaml } = require('./yaml');
const store = require('./store');

// コンパイル条件（事前固定。docs/PLAN-policy-layer.md）。
// 「2件以上」に測定上の根拠は無い — 実装者が決めた閾値であり、反証の対象である。
const MIN_REPEATS = 2;

function rulesDir(osDir) {
  return path.join(osDir, 'rules');
}

function policyFile(osDir, fp) {
  return path.join(rulesDir(osDir), `policy-${fp}.yaml`);
}

// 判断の場の同定。body（言い回し）ではなく situation と options で取る —
// 同じ場が違う言葉で再来したときに一致させるため。
// 抽象化そのものは書き手が行う（機械には決められない）。一致判定だけを決定的にする。
function situationFingerprint(situation, options) {
  const s = String(situation || '').toLowerCase().replace(/\s+/g, '');
  const o = (options || []).map((x) => String(x).toLowerCase().replace(/\s+/g, '')).sort().join('|');
  return require('./util').fingerprint(`${s}##${o}`);
}

function readPolicy(file) {
  try {
    const p = parseYaml(readTextFile(file));
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null; // 壊れた1件で層全体を落とさない
  }
}

// rules/ 配下の方針をすべて読む。ファイルが正本（events.jsonlではない）:
// 方針は「畳み込んだ結果」であり、いつでも決定の履歴から再生成できる派生物である。
function listPolicies(osDir, { activeOnly = false } = {}) {
  const dir = rulesDir(osDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^policy-.*\.yaml$/.test(x)).sort()) {
    const p = readPolicy(path.join(dir, f));
    if (!p || !p.fingerprint) continue;
    if (activeOnly && p.status !== 'active') continue;
    out.push({ ...p, file: path.join(dir, f) });
  }
  return out;
}

function getPolicy(osDir, fp) {
  const file = policyFile(osDir, fp);
  if (!fs.existsSync(file)) return null;
  const p = readPolicy(file);
  return p ? { ...p, file } : null;
}

function writePolicy(osDir, p) {
  const lines = [
    `# 自動生成。決定の履歴から畳み込まれた方針であり、手で書くものではない。`,
    `# 元になった決定は evidence を辿る。unmet が1件記録されると自動で撤回される。`,
    `fingerprint: ${p.fingerprint}`,
    `situation: ${JSON.stringify(p.situation)}`,
    'options:',
    ...(p.options || []).map((o) => `  - ${JSON.stringify(o)}`),
    `choose: ${JSON.stringify(p.choose)}`,
    'because:',
    ...(p.because || []).map((c) => `  - ${JSON.stringify(c)}`),
    'evidence:',
    ...(p.evidence || []).map((e) => `  - ${e}`),
    `compiled_ts: ${p.compiled_ts}`,
    `status: ${p.status}`,
  ];
  if (p.retracted_ts) lines.push(`retracted_ts: ${p.retracted_ts}`);
  if (p.retracted_by) lines.push(`retracted_by: ${p.retracted_by}`);
  if (p.retracted_reason) lines.push(`retracted_reason: ${JSON.stringify(p.retracted_reason)}`);
  if (p.recompile) lines.push(`recompile: ${p.recompile}`);
  atomicWriteFile(policyFile(osDir, p.fingerprint), lines.join('\n') + '\n');
  return getPolicy(osDir, p.fingerprint);
}

// 発火・コンパイル・撤回はすべて機械の記録に残す。トークン消費ゼロであることを
// 主張するには、消費した経路と消費しなかった経路の両方が同じ台帳に載っている必要がある。
function logPolicyEvent(osDir, row) {
  appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
    ts: nowIso(),
    tokens_est: 0, // 推論を使わないので消費はゼロ。実測値であって見積りではない
    ...row,
  });
}

// 決定とoutcomeを fingerprint 別に畳む。decision.js から呼ばれる読み取り専用の集計。
function foldByFingerprint(osDir) {
  const snap = store.getSnapshot(osDir);
  const byFp = {};
  const outcomesByDecision = {};
  for (const id of Object.keys(snap.statements).sort()) {
    const st = snap.statements[id];
    if (st.type !== 'outcome') continue;
    const target = st.decision || (st.links || []).find((l) => l.role === 'derived_from')?.to;
    if (!target) continue;
    (outcomesByDecision[target] = outcomesByDecision[target] || []).push(st);
  }
  for (const id of Object.keys(snap.statements).sort()) {
    const st = snap.statements[id];
    if (st.type !== 'decision' || !st.fingerprint) continue;
    const bucket = byFp[st.fingerprint] = byFp[st.fingerprint] || {
      fingerprint: st.fingerprint,
      situation: st.situation,
      decisions: [],
    };
    const outs = (outcomesByDecision[id] || []).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    bucket.decisions.push({
      id,
      body: st.body,
      chosen: st.chosen,
      options: st.options,
      criteria: st.criteria,
      expected_outcome: st.expected_outcome,
      ts: st.ts,
      outcomes: outs.map((o) => ({ id: o.id, result: o.result, note: o.note, ts: o.ts })),
      latest_result: outs.length ? outs[outs.length - 1].result : null,
    });
  }
  return byFp;
}

// コンパイル可能かを判定する。条件は docs/PLAN-policy-layer.md に事前固定した:
// 同じ選択を MIN_REPEATS 件以上、outcome が1件以上あって全て met、unmet がゼロ。
function compilability(bucket) {
  if (!bucket || !bucket.decisions.length) return { ok: false, why: '決定が無い' };
  const byChoice = {};
  for (const d of bucket.decisions) {
    if (!d.chosen) continue;
    (byChoice[d.chosen] = byChoice[d.chosen] || []).push(d);
  }
  // 失格は「判断の場」ではなく「選択」に対して課す。ある選択が外れたことは、
  // 別の選択が使えないことを意味しない。場ごと永久に失格にすると、
  // 一度の失敗でこの層は二度と働かなくなる。
  const stats = Object.entries(byChoice).map(([choose, list]) => {
    const results = list.flatMap((d) => d.outcomes.map((o) => o.result));
    return {
      choose,
      list,
      met: results.filter((r) => r === 'met').length,
      unmet: results.filter((r) => r === 'unmet').length,
    };
  });
  const eligible = stats.filter((s) => s.list.length >= MIN_REPEATS && s.met > 0 && s.unmet === 0);
  if (!eligible.length) {
    const best = stats.sort((a, b) => b.list.length - a.list.length)[0];
    if (!best) return { ok: false, why: 'chosenが記録された決定が無い' };
    if (best.unmet > 0) {
      return { ok: false, why: `反復している選択「${best.choose}」には unmet がある（外れた選択は畳み込まない）` };
    }
    if (best.met === 0) {
      return { ok: false, why: '結果が met として確認された決定がまだ無い（期待どおりだったかを記録せよ）' };
    }
    return {
      ok: false,
      why: `同じ選択の反復が ${best.list.length} 件で、コンパイル条件（${MIN_REPEATS}件以上）に届かない`,
    };
  }
  if (eligible.length > 1) {
    return { ok: false, why: `反復している選択が複数ある（${eligible.map((s) => s.choose).join(', ')}）。判断の場の切り方が粗い` };
  }
  const [win] = eligible;
  return { ok: true, choose: win.choose, decisions: win.list, met: win.met };
}

// 条件を満たす判断の場を rules/ へ畳み込む。既に active な方針があるものは触らない。
function compile(osDir, { fingerprint: only } = {}) {
  const byFp = foldByFingerprint(osDir);
  const compiled = [];
  const skipped = [];
  for (const fp of Object.keys(byFp).sort()) {
    if (only && fp !== only) continue;
    const bucket = byFp[fp];
    const existing = getPolicy(osDir, fp);
    if (existing && existing.status === 'active') {
      skipped.push({ fingerprint: fp, why: '既に方針が確立している' });
      continue;
    }
    // 場の切り方が粗いとして凍結された判断の場は、situationを切り直すまで畳み込まない。
    // 同じ場で別々の選択がどちらも met になったなら、場の定義が現実と合っていない。
    if (existing && existing.recompile === 'blocked') {
      skipped.push({
        fingerprint: fp,
        situation: bucket.situation,
        why: 'この判断の場は切り方が粗いとして凍結されている。situationを切り直すこと',
      });
      continue;
    }
    const c = compilability(bucket);
    if (!c.ok) {
      skipped.push({ fingerprint: fp, situation: bucket.situation, why: c.why });
      continue;
    }
    // 一度撤回された判断の場を、同じ選択で再びコンパイルし直さない。
    // 反証された直感が黙って復活する経路を作らないため。
    if (existing && existing.status === 'retracted' && existing.choose === c.choose) {
      skipped.push({
        fingerprint: fp,
        situation: bucket.situation,
        why: `この選択は一度反証されて撤回されている（${existing.retracted_by || '?'}）。別の選択で反復を積むこと`,
      });
      continue;
    }
    const because = [...new Set(c.decisions.flatMap((d) => d.criteria || []))];
    const p = writePolicy(osDir, {
      fingerprint: fp,
      situation: bucket.situation,
      options: c.decisions[0].options || [],
      choose: c.choose,
      because,
      evidence: c.decisions.map((d) => d.id),
      compiled_ts: nowIso(),
      status: 'active',
    });
    logPolicyEvent(osDir, { kind: 'policy_compiled', fingerprint: fp, choose: c.choose, evidence: p.evidence.length });
    compiled.push(p);
  }
  return { compiled, skipped };
}

// 判断の場に一致する active な方針を返す。ここが「直感の発火」であり、
// LLMを一切呼ばない。発火は台帳に記録する（無料であることを後から検証できるように）。
function match(osDir, { situation, options, fingerprint: fp, task, log = true } = {}) {
  const key = fp || situationFingerprint(situation, options);
  const p = getPolicy(osDir, key);
  if (!p || p.status !== 'active') return { fingerprint: key, hit: false, policy: null };
  if (log) logPolicyEvent(osDir, { kind: 'policy_hit', fingerprint: key, choose: p.choose, task });
  return { fingerprint: key, hit: true, policy: p };
}

// 反証による撤回。裁量ではなく自動 — unmet が1件出た時点で発火を止める。
// 「例外はあるが方針は正しい」と言えてしまうと、方針は反証不能な信念になる。
function retract(osDir, fp, { by, reason, blockRecompile = false } = {}) {
  const p = getPolicy(osDir, fp);
  if (!p || p.status !== 'active') return null;
  const updated = writePolicy(osDir, {
    ...p,
    status: 'retracted',
    retracted_ts: nowIso(),
    retracted_by: by,
    retracted_reason: reason,
    recompile: blockRecompile ? 'blocked' : undefined,
  });
  logPolicyEvent(osDir, { kind: 'policy_retracted', fingerprint: fp, by, reason });
  return updated;
}

// Reasoning Context に差し込むMarkdown断片。タスクの語と situation の語の重なりで選ぶ
// （決定的な語一致。埋め込みモデルもLLMも使わない）。
function policySection(osDir, terms) {
  const active = listPolicies(osDir, { activeOnly: true });
  if (!active.length) return [];
  const scored = [];
  for (const p of active) {
    const st = String(p.situation || '').toLowerCase();
    const hits = terms.filter((t) => st.includes(t)).length;
    if (hits > 0) scored.push({ p, hits });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => (b.hits - a.hits) || (a.p.fingerprint < b.p.fingerprint ? -1 : 1));
  const parts = ['## 確立済みの方針（過去の決定から畳み込まれたもの。推論を経ていない）', ''];
  for (const { p } of scored.slice(0, 5)) {
    parts.push(`- ${p.situation} → **${p.choose}**（根拠: ${(p.because || []).join(' / ') || '(未記載)'}、出所: ${(p.evidence || []).join(', ')}）`);
  }
  parts.push('');
  parts.push('注: 方針は反復した決定の畳み込みであって、正しさの証明ではない。');
  parts.push('この場で方針に反する判断をしたなら、その理由を成果物に書くこと（撤回の材料になる）。');
  parts.push('');
  return parts;
}

module.exports = {
  MIN_REPEATS,
  situationFingerprint,
  listPolicies,
  getPolicy,
  foldByFingerprint,
  compilability,
  compile,
  match,
  retract,
  policySection,
};
