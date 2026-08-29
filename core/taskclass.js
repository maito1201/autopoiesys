'use strict';
// タスク類型（class）: 「日々同じ種類の仕事をしている」ことを機械が知るための鍵。
//
// classは書き手が付ける1行の抽象であり、機械は抽象化をしない — 同一判定（fingerprint）、
// 再来の提示（suggestClasses）、蒸留の開示強制（recordConsolidation）、系列の取り出し
// （classAttempts）だけを決定的に行う。policy.jsのsituationと同じ分業である:
// 抽象は人が書き、照合は機械が引き受ける。
//
// recordConsolidationが強制するのは開示であって内容ではない（docs/PLAN-daily-loop.md）。
// 「学びなし」も理由つきで通す。helped/misledのフィードバックをlesson側へ書き戻すのは
// experience.jsの担当 — ここはIDを台帳に記録するだけにして、循環requireを避ける。
const path = require('node:path');
const { readJsonl, fingerprint, nowIso } = require('./util');
const store = require('./store');

// evaluate.jsのtasksFileと同じパス（あちらは非公開のため、正本の場所をここにも書く）
function tasksFile(osDir) {
  return path.join(osDir, 'tasks', 'tasks.jsonl');
}

// 類型の同定。policy.jsのsituationFingerprintと同じ正規化規則（小文字化・空白除去）で、
// 同じ類型が違う空白・大文字小文字で書かれても一致させる。言い回しの揺れまでは吸収しない —
// それを機械で吸収しようとすると抽象化を機械に持ち込むことになる。
function classFingerprint(cls) {
  if (typeof cls !== 'string' || !cls.trim()) throw new Error('classは空でない文字列（タスク類型の1行）');
  return fingerprint(cls);
}

// --class省略時に「既存の類型に近いのはこれ」と提示するための材料。
// 候補の語 = classの1行 + その類型の過去タスクのobjective。classは抽象なので
// 具体的な新objectiveと語が重ならないことが多く、過去の同種objectiveを併せて照合する。
// スコアは重なった語の個数（決定的な語一致。埋め込みもLLMも使わない）。
function suggestClasses(osDir, objective) {
  const { extractTerms } = require('./context'); // context.jsは編集しない。語の切り方だけ借りる
  const byId = require('./evaluate').loadTasks(osDir);
  const objTerms = extractTerms(objective);
  if (!objTerms.size) return [];
  const groups = {};
  for (const id of Object.keys(byId).sort()) {
    const t = byId[id];
    if (!t.class) continue;
    const fp = t.class_fp || classFingerprint(t.class);
    // 代表のclass表記は初出タスクのもの（fpが同じなら正規化後は同一。表示用の揺れは初出で固定）
    const g = groups[fp] = groups[fp] || { class: t.class, class_fp: fp, tasks: [], texts: [] };
    g.tasks.push(id);
    g.texts.push(String(t.objective || ''));
  }
  const out = [];
  for (const fp of Object.keys(groups).sort()) {
    const g = groups[fp];
    // テキストごとにextractTermsして和集合を取る（連結してから切るとMAX_TERMSの上限が
    // 後方のタスクの語を静かに落とす）
    const cand = new Set();
    for (const text of [g.class, ...g.texts]) for (const term of extractTerms(text)) cand.add(term);
    let score = 0;
    for (const term of objTerms) if (cand.has(term)) score++;
    // 重なりゼロは「近い類型」の候補にならないので返さない
    if (score > 0) out.push({ class: g.class, class_fp: g.class_fp, tasks: g.tasks, score });
  }
  out.sort((a, b) => (b.score - a.score) || (a.class < b.class ? -1 : 1));
  return out;
}

// StatementのID配列を検証する。実在しないIDや、lesson以外を指すIDを台帳に書くと、
// 後段（experience.jsのfeedback・growthの集計）が静かに空振りするため、記録時に落とす。
function assertLessonIds(snap, ids, name, errors) {
  for (const id of ids) {
    const st = snap.statements[id];
    if (!st) {
      errors.push(`${name}: ${id} は現在状態に存在しない（置換済みか、id誤り）`);
    } else if (st.type !== 'lesson') {
      errors.push(`${name}: ${id} は type: ${st.type}（lessonのIDだけを記録できる）`);
    }
  }
}

function normalizeIdArray(v, name, errors) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${name}はStatement IDの配列`);
    return [];
  }
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim()) errors.push(`${name}に空でないID文字列以外が含まれる`);
  }
  return v;
}

// タスク完了時の蒸留の記録。強制するのは開示であって内容ではない:
// 「何を学んだか（lessons）」か「なぜ学びが無かったか（none_learned）」の
// どちらかを必ず言わせる。両方無い呼び出しは通さない。
// helped/misled = 想起されて効いた/外れた既存lessonのID。ここでは台帳に記録するだけで、
// lesson側へのフィードバック（evidenceのcounters等）はexperience.jsが行う。
// unapplied = 「配信され、適用場面もあったが、適用しなかった」（F009）。
// helped/misled の2値だけでは、正しい教訓を適用しなかった場合に選べる語が無く、
// misled を選ぶと正しい教訓が反証で引退し、無申告だと事象が台帳から消える。
// unapplied は教訓に極性リンクを張らない（教訓は正しい。落ち度は適用の側にある）。
// 理由必須 — 開示の強制であって適用の強制ではない。
function recordConsolidation(osDir, taskId, { lessons, helped, misled, unapplied, unapplied_reason, none_learned, note } = {}) {
  const evaluate = require('./evaluate');
  evaluate.getTask(osDir, taskId); // タスクの実在を先に確認する
  const errors = [];
  const ls = normalizeIdArray(lessons, 'lessons', errors);
  const hp = normalizeIdArray(helped, 'helped', errors);
  const ms = normalizeIdArray(misled, 'misled', errors);
  const un = normalizeIdArray(unapplied, 'unapplied', errors);
  if (un.length && (typeof unapplied_reason !== 'string' || !unapplied_reason.trim())) {
    errors.push('unappliedにはunapplied_reasonが必須（なぜ適用しなかったかの開示。空文字は開示にならない）');
  }
  if (!un.length && typeof unapplied_reason === 'string' && unapplied_reason.trim()) {
    errors.push('unapplied_reasonだけがある（どの教訓を適用しなかったのかをunappliedで指すこと）');
  }
  if (none_learned !== undefined && (typeof none_learned !== 'string' || !none_learned.trim())) {
    errors.push('none_learnedは理由の文字列（空文字は開示にならない）');
  }
  const noneReason = typeof none_learned === 'string' ? none_learned.trim() : '';
  if (!ls.length && !noneReason) {
    errors.push('開示が無い: lessons（このタスクで生まれたlessonのID）か none_learned（学びが無かった理由）のどちらかが必要');
  }
  // 「教訓が生まれた」と「学びが無かった」は両立しない。両方書けると、どちらが真かを
  // 後段の集計が決められなくなる（growthはlessonsを数え、none_learnedはその不在の説明である）
  if (ls.length && noneReason) {
    errors.push('lessonsとnone_learnedは同時に記録できない（学びが有ったのか無かったのか、どちらかに決めよ）');
  }
  // 同じlessonが同じタスクで複数の処遇を持つのは矛盾した開示。
  // experience.js側で相殺のフィードバックが書かれる前に、記録時点で落とす
  for (const [a, an, b, bn] of [[hp, 'helped', ms, 'misled'], [hp, 'helped', un, 'unapplied'], [ms, 'misled', un, 'unapplied']]) {
    const overlap = a.filter((id) => b.includes(id));
    if (overlap.length) {
      errors.push(`${an}と${bn}に同じIDがある: ${[...new Set(overlap)].sort().join(', ')}`);
    }
  }
  if (!errors.length) {
    const snap = store.getSnapshot(osDir);
    assertLessonIds(snap, ls, 'lessons', errors);
    assertLessonIds(snap, hp, 'helped', errors);
    assertLessonIds(snap, ms, 'misled', errors);
    assertLessonIds(snap, un, 'unapplied', errors);
  }
  if (errors.length) throw new Error(`consolidation検証エラー:\n  ${errors.join('\n  ')}`);
  const consolidated = { ts: nowIso(), lessons: ls, helped: hp, misled: ms };
  if (un.length) {
    consolidated.unapplied = un;
    consolidated.unapplied_reason = unapplied_reason.trim();
  }
  if (noneReason) consolidated.none_learned = noneReason;
  if (note) consolidated.note = String(note);
  return evaluate.updateTask(osDir, taskId, { consolidated });
}

// status done なのに蒸留が未記録のタスク。経験が生ログのまま腐っている場所を指す
// （運用ヒントとして別担当が配線する。ここは材料を返すだけ）。
function unconsolidatedDone(osDir) {
  const byId = require('./evaluate').loadTasks(osDir);
  const out = [];
  for (const id of Object.keys(byId).sort()) {
    const t = byId[id];
    if (t.status !== 'done' || t.consolidated) continue;
    out.push({ id: t.id, objective: t.objective, class: t.class || null });
  }
  return out;
}

// その類型の試行の系列（growth側とdigest側の共通部品）。
// 並び順は作成ts（台帳の初出行のts）— タスク台帳は追記式で、マージ後のtsは最終更新時刻に
// なるため、古い試行を後から更新すると系列の順序が入れ替わってしまう。
// 「何回目の試行か」は着手した順で数える。同時刻はid昇順で決定的にする。
function classAttempts(osDir, classFp) {
  const rows = readJsonl(tasksFile(osDir));
  const createdTs = {};
  for (const r of rows) {
    if (r.id && createdTs[r.id] === undefined) createdTs[r.id] = r.ts;
  }
  const byId = require('./evaluate').loadTasks(osDir);
  const out = [];
  for (const id of Object.keys(byId)) {
    const t = byId[id];
    if (!t.class) continue;
    const fp = t.class_fp || classFingerprint(t.class);
    if (fp !== classFp) continue;
    out.push({ ...t, created_ts: createdTs[id] || t.ts });
  }
  out.sort((a, b) => {
    if (a.created_ts !== b.created_ts) return a.created_ts < b.created_ts ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return out;
}

module.exports = {
  classFingerprint,
  suggestClasses,
  recordConsolidation,
  unconsolidatedDone,
  classAttempts,
};
