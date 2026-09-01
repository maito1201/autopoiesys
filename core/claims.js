'use strict';
// 宣言台帳（claims）: 納品と検収を分離する制度の背骨。
//
// カスのコンサル問題（納品時のもっともらしさに報酬が確定し、執行時の現実が
// 提案者に返らない構造）への対策として、成果物は「宣言 + 反証手続き」の形で納品させ、
// 現実（コマンド・時間・ユーザー）が後から採点する。宣言と実際の乖離（較正）が
// タスク類型ごとに蓄積され、乖離の小さい類型は監査確率が下がる —
// **信頼が検収コストを実際に下げる**（裁量という賭け金）。
//
// 規律:
// - 元帳は現実だけから書く。deterministic の検収は Core がコマンドを実行して書く行であり、
//   外部からの deterministic 名乗りは拒否する（verdict台帳と同じ信用境界）
// - broke は較正上 sticky である。一度剥がれた宣言は「実行を生き延びなかった」事実として
//   残り、後から held に直しても較正の乖離には数え続ける（乖離が起きた事実は消えない）
// - 監査の抽選は決定的（タスクID + evaluator + 成果物時刻のハッシュ）。
//   同じ状態への引き直しで結果は変わらない — 実行者が振り直しで検査を回避する経路を作らない
const fs = require('node:fs');
const path = require('node:path');
const { readJsonl, appendJsonl, nowIso, nextId, sha1, readTextFile } = require('./util');

const SETTLE_RESULTS = ['held', 'broke'];
const FALSIFIER_TYPES = ['command', 'file_matches', 'file_not_matches', 'deferred', 'user'];
// command / file_* は今すぐ・後からも機械が執行できる反証手続き。
// deferred は現実・時間が採点する宣言（how = 何がいつこの宣言を剥がすか）。
// user はユーザーの検収だけが採点できる宣言。
const EXECUTABLE_TYPES = ['command', 'file_matches', 'file_not_matches'];

function claimsFile(osDir) {
  return path.join(osDir, 'claims', 'ledger.jsonl');
}

// ---- 検証 ----

function validateFalsifier(f) {
  const errors = [];
  if (!f || typeof f !== 'object') return ['falsifierがオブジェクトでない'];
  if (!FALSIFIER_TYPES.includes(f.type)) {
    errors.push(`falsifier.typeは ${FALSIFIER_TYPES.join('|')}`);
    return errors;
  }
  if (f.type === 'command') {
    if (!Array.isArray(f.argv) || f.argv.length === 0) errors.push('command falsifierはargv配列必須（シェル文字列は禁止）');
  } else if (f.type === 'file_matches' || f.type === 'file_not_matches') {
    if (!f.path) errors.push(`${f.type}: path必須`);
    if (!f.pattern) errors.push(`${f.type}: pattern必須`);
  } else if (f.type === 'deferred' || f.type === 'user') {
    if (typeof f.how !== 'string' || !f.how.trim()) {
      errors.push(`${f.type}: how（何がいつこの宣言を剥がすか）が必須。書けないなら unfalsifiable_reason で開示する`);
    }
  }
  if (f.scope !== undefined && (typeof f.scope !== 'string' || !f.scope)) {
    errors.push('scopeは非空の文字列（対象リポジトリのscope名）');
  }
  return errors;
}

// ---- 台帳の読み書き ----

// 台帳を畳み込む。claim行に settlements を突き合わせ、state を導出する。
//   state: pending | held | broke（最新のsettlementのresult）
//   broke_ever: 一度でもbrokeした事実（較正はこちらを使う。stickyであり消えない）
function loadClaims(osDir) {
  const rows = readJsonl(claimsFile(osDir));
  const byId = {};
  for (const r of rows) {
    if (r.kind === 'claim') {
      byId[r.id] = { ...r, settlements: [], state: 'pending', broke_ever: false };
    } else if (r.kind === 'settlement' && byId[r.claim]) {
      const c = byId[r.claim];
      c.settlements.push(r);
      c.state = r.result;
      if (r.result === 'broke') c.broke_ever = true;
    }
  }
  const byTask = {};
  for (const id of Object.keys(byId).sort()) {
    const c = byId[id];
    if (c.task) (byTask[c.task] = byTask[c.task] || []).push(c);
  }
  return { byId, byTask };
}

function getClaim(osDir, id) {
  const c = loadClaims(osDir).byId[id];
  if (!c) throw new Error(`宣言が存在しない: ${id}`);
  return c;
}

// 宣言を登録する。反証手続き（falsifier）か、反証不能の開示（unfalsifiable_reason）の
// どちらか一方が必須 — 反証手続きの無い宣言を黙って納品物に混ぜる経路を塞ぐ。
function newClaim(osDir, { task, body, falsifier, unfalsifiable_reason } = {}) {
  const errors = [];
  if (!task) errors.push('task欠落');
  if (typeof body !== 'string' || !body.trim()) errors.push('body（宣言の1文）欠落');
  const hasFalsifier = falsifier !== undefined && falsifier !== null;
  const hasReason = typeof unfalsifiable_reason === 'string' && unfalsifiable_reason.trim();
  if (!hasFalsifier && !hasReason) {
    errors.push('falsifier（反証手続き）か unfalsifiable_reason（なぜ反証手続きを書けないか）のどちらかが必須');
  }
  if (hasFalsifier && hasReason) {
    errors.push('falsifierとunfalsifiable_reasonは同時に持てない（反証できるのかできないのか、どちらかに決めよ）');
  }
  if (hasFalsifier) errors.push(...validateFalsifier(falsifier));
  if (errors.length) throw new Error(`claim検証エラー:\n  ${errors.join('\n  ')}`);
  require('./evaluate').getTask(osDir, task); // タスクの実在
  const { byId } = loadClaims(osDir);
  const entry = { kind: 'claim', id: nextId('C', Object.keys(byId), 4), ts: nowIso(), task, body: body.trim() };
  if (hasFalsifier) entry.falsifier = falsifier;
  if (hasReason) entry.unfalsifiable_reason = unfalsifiable_reason.trim();
  appendJsonl(claimsFile(osDir), entry);
  return entry;
}

// 検収を記録する。verdict台帳と同じ信用境界: 外部（CLI経由）は deterministic を名乗れない。
// deterministic の行は Core が反証手続きを実行して書いたもの以外に存在しない。
function recordSettlement(osDir, { claim, result, evidence, provenance, source } = {}, { external = false } = {}) {
  const errors = [];
  if (!claim) errors.push('claim欠落');
  if (!SETTLE_RESULTS.includes(result)) errors.push(`resultは ${SETTLE_RESULTS.join('|')}`);
  if (!Array.isArray(evidence) || evidence.length === 0) errors.push('evidenceは1件以上必須（根拠のない検収は記録できない）');
  if (errors.length) throw new Error(`settlement検証エラー:\n  ${errors.join('\n  ')}`);
  const c = getClaim(osDir, claim);
  let prov = provenance || 'llm';
  if (external && prov === 'deterministic') prov = 'llm'; // 外部の deterministic 名乗りを拒否
  const entry = {
    kind: 'settlement',
    id: `${claim}-s${c.settlements.length + 1}`,
    ts: nowIso(),
    claim,
    result,
    evidence,
    provenance: prov,
  };
  if (source) entry.source = String(source);
  appendJsonl(claimsFile(osDir), entry);
  // 剥がれた宣言は納品の破れである。納品済みタスクをopenへ戻す
  // （較正の乖離としても数え続ける — brokeはsticky）。
  const evaluate = require('./evaluate');
  const t = evaluate.getTask(osDir, c.task);
  const wasCompleted = ['delivered', 'settled', 'done'].includes(t.status);
  let reopened = false;
  let settledTask = false;
  if (result === 'broke' && wasCompleted) {
    evaluate.updateTask(osDir, c.task, {
      status: 'open',
      reopened: { ts: entry.ts, claim, why: `宣言が剥がれた: ${c.body}` },
    });
    reopened = true;
  }
  // 保留の宣言が尽き、剥がれも無ければ、納品済みタスクは検収済みへ進む
  if (result === 'held' && t.status === 'delivered') {
    const after = loadClaims(osDir).byTask[c.task] || [];
    const pending = after.filter((x) => x.state === 'pending' && x.falsifier);
    const broke = after.filter((x) => x.state === 'broke');
    if (!pending.length && !broke.length) {
      evaluate.updateTask(osDir, c.task, { status: 'settled', settled_ts: entry.ts });
      settledTask = true;
    }
  }
  return { ...entry, reopened, task_settled: settledTask };
}

// ---- 反証手続きの執行（現実が採点する経路） ----

// 実行ディレクトリの解決。evaluatorと同じ規則: scope宣言があれば task.repo_dirs[scope]、
// 無ければ task.work_dir → cwd。
function resolveWorkDir(task, falsifier) {
  if (falsifier.scope) {
    const dir = (task.repo_dirs || {})[falsifier.scope];
    if (!dir) throw new Error(`scope=${falsifier.scope} の作業ディレクトリがタスクに登録されていない`);
    return dir;
  }
  return task.work_dir || process.cwd();
}

// 執行可能な反証手続きを今すぐ走らせる。戻り値 { result: held|broke|null, evidence }。
// null = 執行不能（deferred/user、または実行環境エラー）。エラーでbrokeを出さない —
// 「実行できなかった」と「反証された」を混ぜると偽の乖離が較正を汚す。
function runFalsifier(osDir, task, claim) {
  const f = claim.falsifier;
  if (!f || !EXECUTABLE_TYPES.includes(f.type)) return { result: null, evidence: [] };
  let workDir;
  try {
    workDir = resolveWorkDir(task, f);
  } catch (e) {
    return { result: null, evidence: [`実行先を解決できない: ${e.message}`] };
  }
  if (f.type === 'command') {
    const r = require('./evaluate').runCommand(
      { argv: f.argv, expect_exit: f.expect_exit, timeout_ms: f.timeout_ms },
      { workDir }
    );
    if (r.verdict === 'UNCERTAIN') return { result: null, evidence: r.evidence };
    return { result: r.verdict === 'PASS' ? 'held' : 'broke', evidence: r.evidence };
  }
  const p = path.resolve(workDir, f.path);
  if (!fs.existsSync(p)) {
    return { result: null, evidence: [`${f.type} ${f.path}: ファイルが存在しない`] };
  }
  let hit;
  try {
    hit = new RegExp(f.pattern, 'm').test(readTextFile(p));
  } catch (e) {
    return { result: null, evidence: [`${f.type} 実行エラー: ${e.message}`] };
  }
  const ok = f.type === 'file_matches' ? hit : !hit;
  return {
    result: ok ? 'held' : 'broke',
    evidence: [`${f.type} ${f.path} /${f.pattern}/: ${hit ? 'match' : 'no-match'} -> ${ok ? 'held' : 'broke'}`],
  };
}

// 1件の宣言を検収する。
// - 執行可能な反証手続き: Coreが実行し deterministic で記録する（外部の申告は不要）
// - deferred / user / 反証不能: 呼び出し側が result と evidence を持参する必要がある
//   （provenanceはhuman/llm。現実の観測を書き写す行為であり、根拠なしには書けない）
function settleClaim(osDir, claimId, { result, evidence, source, provenance } = {}) {
  const c = getClaim(osDir, claimId);
  const task = require('./evaluate').getTask(osDir, c.task);
  const executable = c.falsifier && EXECUTABLE_TYPES.includes(c.falsifier.type);
  if (executable && result === undefined) {
    const r = runFalsifier(osDir, task, c);
    if (r.result === null) {
      throw new Error(`反証手続きを実行できなかった: ${r.evidence.join(' / ') || '実行不能'}`);
    }
    return recordSettlement(osDir, {
      claim: claimId,
      result: r.result,
      evidence: r.evidence,
      provenance: 'deterministic',
      source: source || 'falsifier',
    });
  }
  if (result === undefined) {
    throw new Error(
      `${claimId} の反証手続きは機械執行できない（${c.falsifier ? c.falsifier.type : '反証不能の宣言'}）。` +
      '--result held|broke と --evidence（現実の観測）を持参せよ'
    );
  }
  return recordSettlement(
    osDir,
    { claim: claimId, result, evidence, provenance: provenance || 'human', source },
    { external: true }
  );
}

// ---- 較正（宣言と実際の乖離） ----

// classFp指定時はその類型のタスクの宣言だけ、無指定は全体。
// gap_rate = broke_ever / settled。brokeはsticky（後からheldに直しても乖離の事実は残る）。
function calibration(osDir, { classFp } = {}) {
  const { byId } = loadClaims(osDir);
  const tasks = require('./evaluate').loadTasks(osDir);
  const rows = [];
  for (const id of Object.keys(byId).sort()) {
    const c = byId[id];
    if (classFp) {
      const t = tasks[c.task];
      if (!t || (t.class_fp || null) !== classFp) continue;
    }
    rows.push(c);
  }
  const settled = rows.filter((c) => c.settlements.length > 0);
  const broke = settled.filter((c) => c.broke_ever);
  const unfalsifiable = rows.filter((c) => !c.falsifier);
  // 直近の乖離（forced audit用）: 最新のsettlement ts順で末尾5件にbrokeが含まれるか
  const bySettleTs = settled
    .map((c) => ({ c, ts: c.settlements[c.settlements.length - 1].ts }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = bySettleTs.slice(-5);
  return {
    claims: rows.length,
    settled: settled.length,
    held: settled.length - broke.length,
    broke: broke.length,
    pending: rows.filter((c) => c.state === 'pending' && c.falsifier).length,
    unfalsifiable: unfalsifiable.length,
    gap_rate: settled.length ? broke.length / settled.length : null,
    recent_broke: recent.some((x) => x.c.broke_ever && x.c.state !== 'pending'
      && x.c.settlements.some((s) => s.result === 'broke')),
  };
}

// ---- 信用価格と監査抽選（裁量という賭け金） ----

const TRUST_DEFAULTS = { enabled: true, floor: 0.25, min_history: 5 };

function trustConfig(cfg) {
  const t = (cfg && cfg.trust) || {};
  return {
    enabled: t.enabled !== undefined ? !!t.enabled : TRUST_DEFAULTS.enabled,
    floor: typeof t.floor === 'number' && t.floor > 0 && t.floor <= 1 ? t.floor : TRUST_DEFAULTS.floor,
    min_history: typeof t.min_history === 'number' && t.min_history > 0 ? t.min_history : TRUST_DEFAULTS.min_history,
  };
}

// 決定的な抽選値 [0,1)。同じ (task, evaluator, 成果物時刻) からは常に同じ値 —
// 引き直しで検査を回避できない。成果物が変われば新しい状態として引き直される。
function auditDraw(taskId, evaluatorId, stateTs) {
  const h = sha1(`${taskId}:${evaluatorId}:${stateTs || ''}`);
  return parseInt(h.slice(0, 8), 16) / 0x100000000;
}

// このタスクのこのllm_judgeを今回のstateで監査するか。
// 検査の緩和が許されるのは緑の実績に対してだけ:
//   - trust無効 / 較正の履歴不足（cold start）/ 直近に乖離 / 前回verdictが非PASS → 必ず監査
//   - それ以外 → p = max(floor, min(1, 2 × gap_rate)) の決定的抽選
// 戻り値 { audit, p, draw, basis }。basisは判断根拠の開示（自己申告ではなく機械記録）。
function auditDecision(osDir, task, def, { lastVerdict } = {}) {
  if (!def || def.method !== 'llm_judge') return { audit: true, p: 1, basis: 'not_llm_judge' };
  let cfg = null;
  try {
    cfg = require('./schema').loadConfig(osDir);
  } catch {
    cfg = null;
  }
  const tc = trustConfig(cfg);
  if (!tc.enabled) return { audit: true, p: 1, basis: 'trust_disabled' };
  if (lastVerdict && lastVerdict.verdict !== 'PASS') {
    return { audit: true, p: 1, basis: `prior_non_pass:${lastVerdict.verdict}` };
  }
  const cal = calibration(osDir, { classFp: task.class_fp || undefined });
  if (cal.settled < tc.min_history) {
    return { audit: true, p: 1, basis: `cold_start:${cal.settled}/${tc.min_history}`, calibration: cal };
  }
  if (cal.recent_broke) {
    return { audit: true, p: 1, basis: 'recent_broke', calibration: cal };
  }
  const p = Math.max(tc.floor, Math.min(1, 2 * (cal.gap_rate || 0)));
  const evaluate = require('./evaluate');
  const stateTs = evaluate.lastArtifactTs(task) || task.ts;
  const u = auditDraw(task.id, def.id, stateTs);
  return {
    audit: u < p,
    p,
    draw: u,
    basis: `sampled:gap_rate=${(cal.gap_rate || 0).toFixed(2)},n=${cal.settled}`,
    calibration: cal,
  };
}

// 類型の較正実績を人が読む行にする（task new / brief で実行者の文脈に注入する —
// 持続する自己は、セッションを跨いで蓄積され毎回文脈に返る実績のことである）。
function calibrationLines(osDir, { classFp, label } = {}) {
  const cal = calibration(osDir, { classFp });
  if (!cal.claims) return [];
  const lines = [`## 較正実績（${label || (classFp ? 'この類型' : '全体')}。宣言が実行を生き延びた記録）`];
  lines.push(
    `宣言${cal.claims}件: held ${cal.held} / broke ${cal.broke} / 保留 ${cal.pending} / 反証不能 ${cal.unfalsifiable}` +
    (cal.gap_rate !== null ? `（乖離率 ${(cal.gap_rate * 100).toFixed(0)}%）` : '')
  );
  if (cal.gap_rate !== null) {
    if (cal.recent_broke) {
      lines.push('直近に剥がれた宣言がある。この類型の判定は全数監査に戻っている（信用は実績で買い戻す）');
    } else {
      const p = Math.max(TRUST_DEFAULTS.floor, Math.min(1, 2 * cal.gap_rate));
      lines.push(`現在の監査率 p≈${p.toFixed(2)}。乖離の小さい宣言を積むほど検収は薄くなる`);
    }
  }
  return lines;
}

// 台帳の整合検査（`autopoiesys check` 用）。壊れた参照を黙って落とすと
// 「読めなかった」が「無かった」に化ける（F008と同型）ので、ここで名指しする。
function lintClaims(osDir) {
  const rows = readJsonl(claimsFile(osDir));
  const errors = [];
  const claimIds = new Set(rows.filter((r) => r.kind === 'claim').map((r) => r.id));
  let tasks = null;
  for (const r of rows) {
    if (r.kind === 'settlement') {
      if (!claimIds.has(r.claim)) errors.push(`claims: 検収 ${r.id} が存在しない宣言を指している: ${r.claim}`);
      if (!SETTLE_RESULTS.includes(r.result)) errors.push(`claims: 検収 ${r.id} のresultが不正: ${r.result}`);
    } else if (r.kind === 'claim') {
      if (!tasks) tasks = require('./evaluate').loadTasks(osDir);
      if (r.task && !tasks[r.task]) errors.push(`claims: 宣言 ${r.id} が存在しないタスクを指している: ${r.task}`);
    } else {
      errors.push(`claims: 未知のkind: ${r.kind}（${r.id || '?'}）`);
    }
  }
  return { errors, count: claimIds.size };
}

module.exports = {
  SETTLE_RESULTS,
  FALSIFIER_TYPES,
  EXECUTABLE_TYPES,
  claimsFile,
  validateFalsifier,
  loadClaims,
  getClaim,
  newClaim,
  recordSettlement,
  runFalsifier,
  settleClaim,
  calibration,
  trustConfig,
  auditDraw,
  auditDecision,
  calibrationLines,
  lintClaims,
};
