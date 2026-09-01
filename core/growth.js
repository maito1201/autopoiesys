'use strict';
// 成長の実測（docs/PLAN-daily-loop.md「成長の実測」）。
// 「回数を重ねるほど良くなっている」は、系列を出さない限り主張のままである。
// ここがやるのは類型（class_fp）ごとに試行を時系列で並べ、機械記録だけを数えること:
//   - FAIL / UNCERTAIN数 … evaluations/log.jsonl（独立評価の記録。自己申告ではない）
//   - トークン … observations/context_log.jsonl の kind:briefing（実際に生成したbriefingの実測）
//   - 教訓数 … task.consolidated.lessons（consolidateで開示された学び）
//
// **傾向の断定はしない。** 「成長している/していない」を機械が言い始めたら、
// それは集計ではなく解釈であり、反証の対象を出力に焼き付けることになる。
// 数字がどう動いたかの判断は読み手に渡す（3回未満の類型では傾向を語らない —
// この規律だけは出力に焼き込む）。
const path = require('node:path');
const { readJsonl } = require('./util');

// 傾向を語ってよい最小試行数（事前固定。docs/PLAN-daily-loop.md）。
// 統計的根拠のある閾値ではなく規律であり、これ未満では但し書きを必ず出す。
const MIN_ATTEMPTS_FOR_TREND = 3;

function tasksFile(osDir) {
  return path.join(osDir, 'tasks', 'tasks.jsonl');
}

function verdictLog(osDir) {
  return path.join(osDir, 'evaluations', 'log.jsonl');
}

function contextLog(osDir) {
  return path.join(osDir, 'observations', 'context_log.jsonl');
}

// consolidateで開示された教訓の数。未consolidate（null）と「学びなし」（0）は区別する —
// nullは「まだ開示していない」、0は「開示した上で学びが無かった」であり、意味が違う。
function lessonsProduced(task) {
  if (!task.consolidated) return null;
  const l = task.consolidated.lessons;
  if (Array.isArray(l)) return l.length;
  if (typeof l === 'number') return l;
  return 0;
}

// 類型ごとの試行系列。戻り値 {classFp: {class, attempts: [...]}}。
// 試行の順序は**作成時刻**（tasks.jsonlの同一idの最初の行のts）の昇順。
// 台帳の最新行のtsは更新のたびに動くため、それで並べると後から触ったタスクが
// 系列の末尾に移動し、「何回目の試行か」が壊れる。
function growthSeries(osDir) {
  const rows = readJsonl(tasksFile(osDir));
  const merged = {};
  const createdTs = {};
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (!(r.id in merged)) createdTs[r.id] = r.ts;
    merged[r.id] = { ...(merged[r.id] || {}), ...r };
  }

  // verdictは最新1件ではなく全行を数える。FAILの総数が「決定的な差し戻し回数」の
  // 代理であり、最後にPASSしたことはFAILが無かったことを意味しない。
  const vstats = {};
  for (const v of readJsonl(verdictLog(osDir))) {
    const s = vstats[v.task] = vstats[v.task] || { fails: 0, uncertains: 0, verdicts: 0 };
    s.verdicts += 1;
    if (v.verdict === 'FAIL') s.fails += 1;
    else if (v.verdict === 'UNCERTAIN') s.uncertains += 1;
  }

  // context_logにはpolicy発火等のイベントも混ざる。briefingの実測だけを数える。
  // 合計だけを出すと、briefingの回数差（2回 vs 1回）がサイズの改善に見える
  // （実例: 3049→1499と報告されたが、1回あたりは1454→1595→1499で横ばいだった）。
  // 回数を併記して、読み手が合計÷回数を取れるようにする。
  const tokensByTask = {};
  const briefingsByTask = {};
  for (const c of readJsonl(contextLog(osDir))) {
    if (c.kind !== 'briefing' || !c.task) continue;
    tokensByTask[c.task] = (tokensByTask[c.task] || 0) + (c.tokens_est || 0);
    briefingsByTask[c.task] = (briefingsByTask[c.task] || 0) + 1;
  }

  // 評価FAILだけを数えると、evaluator全PASSでユーザーに差し戻された試行が
  // 「無傷」に見える（実例: 評価5件PASSの成果物が目的の取り違えで作り直しになった）。
  // Failure台帳のうちそのタスクに紐づく起票を、別列として系列に持たせる。
  const failuresByTask = {};
  for (const f of readJsonl(path.join(osDir, 'failures', 'ledger.jsonl'))) {
    if (f.state !== 'reported' || !f.task) continue;
    failuresByTask[f.task] = (failuresByTask[f.task] || 0) + 1;
  }

  const ids = Object.keys(merged).sort((a, b) => {
    const ta = createdTs[a] || '';
    const tb = createdTs[b] || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a < b ? -1 : 1; // 同秒作成はID順（nextIdの連番＝発番順）
  });

  const byClass = {};
  for (const id of ids) {
    const t = merged[id];
    // 類型を持たないタスクは系列に含めない。class_fpをここで補完計算しないのは、
    // 指紋の計算規則をtaskclass側に一元化するため（二重実装は静かにずれる）。
    if (!t.class_fp) continue;
    // 取り下げたタスク（誤登録）は試行ではない。数えると成長の系列が汚れる（F013。
    // 実測: 壊れた登録が「試行10回目」として並び、差し戻し1件として集計されていた）
    if (t.status === 'withdrawn') continue;
    const bucket = byClass[t.class_fp] = byClass[t.class_fp] || { class: t.class, attempts: [] };
    const s = vstats[id] || { fails: 0, uncertains: 0, verdicts: 0 };
    bucket.attempts.push({
      task: { id, objective: t.objective, ts: createdTs[id] },
      fails: s.fails,
      uncertains: s.uncertains,
      verdicts: s.verdicts,
      user_failures: failuresByTask[id] || 0,
      tokens: tokensByTask[id] || 0,
      briefings: briefingsByTask[id] || 0,
      lessons_produced: lessonsProduced(t),
      done: require('./evaluate').isCompleted(t),
    });
  }
  return byClass;
}

// 人が読む形（Markdown行の配列）。classQueryは類型名の部分一致（大文字小文字を無視）。
// 表を並べるだけで、傾向の断定文は出さない — 出した瞬間、それは測定ではなく主張になる。
// 配信された教訓と、consolidateでの処遇の突き合わせ（タスク×教訓の組で数える）。
// 分母は配信の機械記録（kind: digest）で、実行者の申告に依存しない
function deliveryDisposition(osDir) {
  const path = require('node:path');
  const { readJsonl } = require('./util');
  const tasks = require('./evaluate').loadTasks(osDir);
  const deliveredBy = {};
  for (const c of readJsonl(path.join(osDir, 'observations', 'context_log.jsonl'))) {
    if (c.kind !== 'digest' || !c.task) continue;
    const set = (deliveredBy[c.task] = deliveredBy[c.task] || new Set());
    for (const l of c.lessons || []) set.add(l);
  }
  let delivered = 0;
  let helped = 0;
  let misled = 0;
  let unapplied = 0;
  let silent = 0;
  for (const [taskId, set] of Object.entries(deliveredBy)) {
    const c = (tasks[taskId] || {}).consolidated;
    for (const id of set) {
      delivered++;
      if (c && (c.helped || []).includes(id)) helped++;
      else if (c && (c.misled || []).includes(id)) misled++;
      else if (c && (c.unapplied || []).includes(id)) unapplied++;
      else silent++;
    }
  }
  return { delivered, helped, misled, unapplied, silent };
}

function growthReport(osDir, classQuery) {
  const series = growthSeries(osDir);
  const fps = Object.keys(series);
  const lines = [];
  if (!fps.length) {
    lines.push('類型（class）を持つタスクがまだ無い。task new --class "<1行の抽象>" で付けると系列が始まる');
    return lines;
  }
  const q = classQuery ? String(classQuery).toLowerCase() : null;
  const picked = fps
    .filter((fp) => !q || String(series[fp].class || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const ca = String(series[a].class || '');
      const cb = String(series[b].class || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a < b ? -1 : 1;
    });
  if (!picked.length) {
    lines.push(`部分一致する類型が無い: ${classQuery}`);
    return lines;
  }
  lines.push('# 類型別の試行系列');
  lines.push('');
  for (const fp of picked) {
    const { class: cls, attempts } = series[fp];
    lines.push(`## ${cls}（fp=${fp}）`);
    lines.push('');
    lines.push('| 試行 | task | FAIL | UNCERTAIN | 差し戻し | トークン(briefing数) | 教訓 | 完了 |');
    lines.push('|---:|---|---:|---:|---:|---:|---:|:---|');
    attempts.forEach((a, i) => {
      // 教訓の「-」は未consolidate（開示がまだ）。0は「開示した上で学びなし」。
      // 差し戻し = そのタスクに紐づくFailure起票（評価全PASSでも人が拒否した回を可視化する）
      const lessons = a.lessons_produced === null ? '-' : String(a.lessons_produced);
      lines.push(`| ${i + 1} | ${a.task.id} | ${a.fails} | ${a.uncertains} | ${a.user_failures || 0} | ${a.tokens}(${a.briefings || 0}) | ${lessons} | ${a.done ? 'done' : 'open'} |`);
    });
    lines.push('');
    if (attempts.length < MIN_ATTEMPTS_FOR_TREND) {
      lines.push(`試行${attempts.length}回。傾向を語るには足りない`);
      lines.push('');
    }
  }
  // 「効いた/外れた」は実行者の申告である。独立監査（experience audit）を通った件数を
  // 分母つきで併記する — 申告と検証を同じ語で呼ぶと、実績数が自己申告の合計になる（S0033/S0035）
  try {
    const cov = require('./claimaudit').auditCoverage(osDir);
    lines.push(`教訓の効き目の申告: ${cov.claimed}件中 ${cov.audited}件が独立監査済み`
      + `（整合 ${cov.by_result.supported} / 食い違い ${cov.by_result.contradicted} / 判定不能 ${cov.by_result.insufficient}）`);
    if (cov.claimed > cov.audited) {
      lines.push(`未監査の申告が ${cov.claimed - cov.audited} 件ある（node cli/index.js experience audit <task>）`);
    }
    lines.push('');
  } catch {
    // 監査層が無くても系列表は出す
  }
  // 配信→処遇の突き合わせ（F009）。「届いたのに無処遇」が経験再利用の測れない穴になる。
  // 分母（配信数）を必ず併記する（S0033）
  try {
    const d = deliveryDisposition(osDir);
    lines.push(`想起の配信と処遇: 配信${d.delivered}件のうち 効いた${d.helped} / 外れた${d.misled} / 適用せず${d.unapplied} / 無処遇${d.silent}`);
    if (d.silent > 0) {
      lines.push('無処遇の配信は「届いたが黙って無視された」可能性がある（task consolidate の --helped/--misled/--unapplied で開示する）');
    }
    lines.push('');
  } catch {
    // 配信ログが無くても系列表は出す
  }
  lines.push('注: この表は系列を並べただけである。数字の解釈は読み手が行う。教訓の「-」は未consolidate。');
  lines.push('注: helped/misled は実行者の申告であり、独立監査を通るまで検証済みではない。');
  return lines;
}

// 直近の試行のFAILがその前の試行より増えている類型。agendaの材料であって判定ではない —
// 「悪化」と呼ぶかどうかも含め、扱いは呼び出し側（と読み手）が決める。
function worseningClasses(osDir) {
  const series = growthSeries(osDir);
  const out = [];
  for (const fp of Object.keys(series).sort()) {
    const { class: cls, attempts } = series[fp];
    if (attempts.length < 2) continue; // 比較対象が無い
    const last = attempts[attempts.length - 1];
    const prev = attempts[attempts.length - 2];
    if (last.fails > prev.fails) {
      out.push({ class: cls, class_fp: fp, last_fails: last.fails, prev_fails: prev.fails });
    }
  }
  return out;
}

module.exports = {
  MIN_ATTEMPTS_FOR_TREND,
  growthSeries,
  growthReport,
  worseningClasses,
};
