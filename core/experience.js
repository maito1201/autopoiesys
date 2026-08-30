'use strict';
// 経験層（蒸留と自動想起）。PLAN-daily-loop.md の「蒸留・自動想起・書き戻し」を担う。
//
// モデルは自分が何を思い出せていないかを知らない。想起を実行者の善意に委ねると、
// 一番必要なとき（同種のタスクの再来時）に一番落ちる。ここでは:
//   - 蒸留（何を1行にするか）は書き手がやる。機械は届ける・照合する・数えるだけ
//   - 想起は決定的な順位づけ（類型一致・scope一致・語一致）で黙っていても届く
//   - 使った教訓が効いたか外れたかは evidence の supports/counters で書き戻す
//   - 反証された教訓（counters > supports）は想起から自動で外れる。
//     方針の自動撤回（policy.retract）と同じ規律 — 「例外はあるが教訓は正しい」を許さない
//
// 保存層は作らない: 教訓は type: lesson のStatementとして world_model/events.jsonl に載る。
// ここでの計算はすべて索引・照合・集計で、LLMを呼ばない。
const store = require('./store');
const policy = require('./policy');
const failure = require('./failure');
const { loadTasks } = require('./evaluate');
const { extractTerms } = require('./context');
const { estimateTokens, appendJsonl, nowIso } = require('./util');
const path = require('node:path');

// 順位づけの重み（事前固定。測定上の根拠は無い — 実装者が決めた値であり反証の対象）。
// 類型一致 > scope一致 > 語一致 の順は「同じ仕事の再来に一番効くのは同じ仕事の教訓」
// という仮説の翻訳で、digestの実績（helped/misled）が外れを示したら見直す。
const SCORE_CLASS = 5;
const SCORE_SCOPE = 2;
const SCORE_TERM = 1;
const MAX_TERM_HITS = 3;

function assertStringArray(v, label) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error(`${label}は空でない文字列の配列`);
  }
  return v;
}

// terms引数（Set / 配列 / undefined）を小文字のSetに正規化する
function normalizeTerms(terms) {
  const out = new Set();
  for (const t of terms || []) {
    const s = String(t).toLowerCase().trim();
    if (s) out.add(s);
  }
  return out;
}

// 経験を1行の教訓として記録する。when=適用条件、task_class=類型fingerprint。
// origin_task/origin_failureは provenance に残す（derived_fromはStatement ID専用の
// linkロールなので、Failure台帳のIDは provenance.ref で辿れれば足りる）。
function recordLesson(osDir, body, opts = {}) {
  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new Error('bodyが必要（次に同種の仕事をするとき使える教訓を1行で）');
  }
  const tags = assertStringArray(opts.tags, 'tags');
  const scope = assertStringArray(opts.scope, 'scope');
  const provenance = { source: opts.source || 'experience', method: opts.method || 'llm' };
  if (opts.origin_task) provenance.task = opts.origin_task;
  if (opts.origin_failure) provenance.ref = opts.origin_failure;
  const st = {
    type: 'lesson',
    body,
    status: 'fact',
    when: opts.when,
    task_class: opts.task_class,
    tags,
    scope,
    provenance,
  };
  for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
  // when/task_classの形式検証はstore側（validateStatement）に一元化されている
  const r = store.assertStatements(osDir, [st]);
  return { id: r.added[0], statement: st, warnings: r.warnings };
}

// あるlessonへの書き戻し実績。現在状態のevidenceが supports/counters ロールで
// 張ってきた本数を数える（supersede/retractされた書き戻しは自動で消える）。
function feedbackCounts(snapshot, lessonId) {
  let helped = 0;
  let misled = 0;
  for (const l of (snapshot.indexes.links_in || {})[lessonId] || []) {
    const from = snapshot.statements[l.from];
    if (!from || from.type !== 'evidence') continue;
    if (l.role === 'supports') helped++;
    else if (l.role === 'counters') misled++;
  }
  return { helped, misled };
}

// 想起の中核。決定的な順位づけで教訓を選ぶ。
// 反証された教訓（counters > supports）は返さず、excludedとして別途返す —
// 黙って消すと「なぜ届かないか」を誰も追えなくなるため、除外は必ず可視にする。
function lessonsFor(osDir, { classFp, terms, scope, bornIds } = {}) {
  const snapshot = store.getSnapshot(osDir);
  const termSet = normalizeTerms(terms);
  const scopes = scope === undefined ? [] : (Array.isArray(scope) ? scope : [scope]);
  const born = bornIds instanceof Set ? bornIds : new Set(bornIds || []);
  const candidates = [];
  for (const id of (snapshot.indexes.by_type || {}).lesson || []) {
    const st = snapshot.statements[id];
    let score = 0;
    // 類型一致は2経路: task_classの明示宣言、または同類型タスクのconsolidateで生まれたこと。
    // 後者が無いと、--task-class を付け忘れた教訓は同じ仕事の再来に届かない
    // （語の偶然に想起を任せることになり、実測でこの取り落としが起きた）
    if ((classFp && st.task_class === classFp) || born.has(id)) score += SCORE_CLASS;
    if (scopes.length && (st.scope || []).some((sc) => scopes.includes(sc))) score += SCORE_SCOPE;
    // タグ/本文の語一致。2-gramは緩い一致器なので上限を設け、
    // 語の重なりだけで無関係な教訓が上位に来るのを防ぐ
    const haystack = `${(st.tags || []).join(' ')} ${st.body || ''}`.toLowerCase();
    let hits = 0;
    for (const t of termSet) {
      if (hits >= MAX_TERM_HITS) break;
      if (haystack.includes(t)) hits++;
    }
    score += hits * SCORE_TERM;
    if (score <= 0) continue;
    const { helped, misled } = feedbackCounts(snapshot, id);
    candidates.push({ id, body: st.body, when: st.when, score, helped, misled });
  }
  const lessons = [];
  const excluded = [];
  for (const c of candidates) {
    if (c.misled > c.helped) {
      excluded.push({
        id: c.id,
        body: c.body,
        why: `外れ${c.misled}回 > 効き${c.helped}回（反証された教訓は想起から外す）`,
      });
    } else {
      lessons.push(c);
    }
  }
  // 同点でも順序が揺れない（score降順 → id昇順）
  lessons.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
  excluded.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { lessons, excluded };
}

// consolidate時の書き戻し。使った教訓が効いたか外れたかを evidence の極性リンクで残す。
// これが無いと「使った経験が効いたかを知る経路」が存在せず、蒸留の害を検出できない。
function feedback(osDir, { helped, misled, task, source } = {}) {
  if (!task || typeof task !== 'string') throw new Error('taskが必要（どのタスクでの実績かを書き戻しに残す）');
  const helpedIds = assertStringArray(helped, 'helped') || [];
  const misledIds = assertStringArray(misled, 'misled') || [];
  const both = helpedIds.filter((id) => misledIds.includes(id));
  if (both.length) {
    throw new Error(`同じ教訓をhelpedとmisledの両方に入れることはできない: ${both.join(', ')}（極性が矛盾している）`);
  }
  const snapshot = store.getSnapshot(osDir);
  const statements = [];
  const build = (id, role, verb) => {
    const st = snapshot.statements[id];
    if (!st) throw new Error(`教訓が現在状態に存在しない: ${id}`);
    if (st.type !== 'lesson') throw new Error(`${id} はtype: lessonではない（${st.type}）。feedbackの対象は教訓のみ`);
    statements.push({
      type: 'evidence',
      body: `タスク${task}でこの教訓が${verb}`,
      status: 'fact',
      links: [{ role, to: id }],
      provenance: { source: source || 'consolidate', method: 'llm', task },
    });
  };
  for (const id of helpedIds) build(id, 'supports', '有効だった');
  for (const id of misledIds) build(id, 'counters', '誤誘導した');
  if (!statements.length) return { added: [], warnings: [] };
  // 1バッチで書く（1件でも不正なら何も書かれない）
  const r = store.assertStatements(osDir, statements);
  return { added: r.added, warnings: r.warnings };
}

// 語の重なり（1件以上）。digestの各節が使う共通の照合。
function overlaps(termSet, text) {
  const s = String(text || '').toLowerCase();
  for (const t of termSet) if (s.includes(t)) return true;
  return false;
}

// 想起で配る決定の上限。多いほど良いものではない（想起そのものが文脈を食う）。
const DIGEST_DECISION_LIMIT = 6;
const DECISION_MIN_HITS = 3;

// 語の重なりの件数。overlaps（1件以上で真）より強い条件が要る場所で使う
function termHits(termSet, text) {
  const s = String(text || '').toLowerCase();
  let n = 0;
  for (const t of termSet) if (s.includes(t)) n++;
  return n;
}

// この仕事に効く過去の決定。関連の判定は語の重なりと類型の一致だけ（LLMを呼ばない）。
function decisionItems(osDir, termSet, pastTaskIds) {
  const byFp = policy.foldByFingerprint(osDir);
  const fromClass = new Set(pastTaskIds || []);
  const rows = [];
  for (const fp of Object.keys(byFp).sort()) {
    const b = byFp[fp];
    // 語の重なりで拾うときは decision.js の近傍照合と同じ最小一致数を要求する。
    // situationは「〜を選ぶ」のような共通の枠を持つので、1件の重なりでは全部が当たる
    const overlap = termHits(termSet, b.situation) >= DECISION_MIN_HITS;
    for (const d of b.decisions) {
      const sameClass = d.task && fromClass.has(d.task);
      if (!overlap && !sameClass) continue;
      rows.push({
        id: d.id,
        fingerprint: fp,
        situation: b.situation,
        chosen: d.chosen,
        result: d.latest_result,
        task: d.task,
        why: sameClass ? '同じ類型の仕事で下した' : '判断の場の語が重なる',
      });
    }
  }
  // 結果が未記録のものを先に出す（答え合わせができる状態にある決定を埋もれさせない）
  rows.sort((a, b) => (a.result ? 1 : 0) - (b.result ? 1 : 0) || (a.id < b.id ? -1 : 1));
  return rows.slice(0, DIGEST_DECISION_LIMIT);
}

// タスク開始時に黙って届ける想起の束。集めるものはすべて決定的（索引・照合・集計のみ）。
// task = {id, objective, class, class_fp, repo_dirs}
function digest(osDir, task) {
  if (!task || typeof task !== 'object') throw new Error('taskが必要（{id, objective, class_fp, repo_dirs}）');
  const termSet = normalizeTerms(extractTerms(task.objective || ''));
  const scopes = Object.keys(task.repo_dirs || {});

  // (1) 同じ類型の過去タスク。何を作り、どう終わり、何を学んだか
  const pastTasks = [];
  if (task.class_fp) {
    const byId = loadTasks(osDir);
    for (const id of Object.keys(byId).sort()) {
      const t = byId[id];
      if (id === task.id || t.class_fp !== task.class_fp) continue;
      pastTasks.push({
        id,
        objective: t.objective,
        status: t.status,
        lessons: (t.consolidated && t.consolidated.lessons) || [],
      });
    }
  }

  // (2) 教訓（反証済みは自動で外れる）。同類型タスクの蒸留で生まれた教訓は、
  //     task_classの付け忘れがあっても届ける（bornIds経由の類型一致）
  const bornIds = new Set(pastTasks.flatMap((t) => t.lessons));
  const lf = lessonsFor(osDir, { classFp: task.class_fp, terms: termSet, scope: scopes, bornIds });

  // (3) 確立済みの方針のうち、この仕事の語と重なるもの
  const policies = policy.listPolicies(osDir, { activeOnly: true })
    .filter((p) => overlaps(termSet, p.situation))
    .map((p) => ({ fingerprint: p.fingerprint, situation: p.situation, choose: p.choose, because: p.because || [] }))
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));

  // (3') 過去の決定そのもの。方針（3）は「反復して結果が伴った決定」からしか生まれず、
  //      結果が1件も無い間は永久に空になる。決定を配らなければ、判断の経験は
  //      実行者に一切届かない — 引きに来させる層（decision recall）は死ぬ、というのが
  //      教訓層（配信の機械記録あり）との対比で観測された事実である。
  //      対象は (a) 同じ類型の過去タスクで下した決定、(b) situationがこの仕事の語と重なる決定。
  const decisions = decisionItems(osDir, termSet, pastTasks.map((t) => t.id));

  // (4) 未消化のFailure（implemented/accepted_risk以外）のうち、症状が語と重なるもの
  const failures = Object.values(failure.loadFailures(osDir))
    .filter((f) => !failure.TERMINAL.includes(f.state) && overlaps(termSet, f.symptom))
    .map((f) => ({ id: f.id, state: f.state, symptom: f.symptom }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // (5) 第一級のUnknownのうち、構造（blocks/importance）を持ち、語と重なるもの
  const snapshot = store.getSnapshot(osDir);
  const unknowns = ((snapshot.indexes.by_type || {}).unknown || [])
    .map((id) => snapshot.statements[id])
    .filter((st) => ((Array.isArray(st.blocks) && st.blocks.length) || st.importance !== undefined)
      && overlaps(termSet, st.body))
    .map((st) => ({ id: st.id, body: st.body, blocks: st.blocks || [], importance: st.importance }))
    .sort((a, b) => ((b.importance || 0) - (a.importance || 0)) || (a.id < b.id ? -1 : 1));

  const lines = ['## この仕事に効く過去の経験（黙っていても届く想起。取捨は実行者が判断する）', ''];
  const empty = !pastTasks.length && !lf.lessons.length && !lf.excluded.length
    && !policies.length && !decisions.length && !failures.length && !unknowns.length;
  if (empty) {
    lines.push('この類型は初回。終わったら教訓を残せ');
  } else {
    if (pastTasks.length) {
      lines.push(`### 同じ類型の過去タスク（${pastTasks.length}件）`);
      for (const t of pastTasks) {
        lines.push(`- ${t.id}「${t.objective}」（status: ${t.status}${t.lessons.length ? `、教訓: ${t.lessons.join(', ')}` : ''}）`);
      }
      lines.push('');
    }
    if (lf.lessons.length) {
      lines.push('### 教訓');
      for (const l of lf.lessons) {
        lines.push(`- ${l.id}: ${l.body}${l.when ? `（適用条件: ${l.when}）` : ''} — 効いた${l.helped}回/外れた${l.misled}回`);
      }
      lines.push('');
    }
    // 除外は黙って行わない。「届かなかった教訓がある」こと自体は実行者に見せる
    // （どの教訓が反証されたかを追う入口を残す。件数とIDのみで本文は載せない）
    if (lf.excluded.length) {
      lines.push(`（反証された教訓${lf.excluded.length}件（${lf.excluded.map((e) => e.id).join(', ')}）は想起から外した）`);
      lines.push('');
    }
    if (policies.length) {
      lines.push('### 確立済みの方針（過去の決定の畳み込み。推論を経ていない）');
      for (const p of policies) lines.push(`- ${p.situation} → **${p.choose}**`);
      lines.push('');
    }
    if (decisions.length) {
      lines.push('### 過去の決定（同じ場に戻ってきたなら、前回の選択と結果を見てから決めよ）');
      for (const d of decisions) {
        lines.push(
          `- ${d.id}「${d.situation}」→ ${d.chosen || '(選択が未記録)'}` +
          `（結果: ${d.result || '**未記録**'} | ${d.why}）`
        );
      }
      const pending = decisions.filter((d) => !d.result);
      if (pending.length) {
        lines.push('');
        lines.push(
          `結果が未記録の決定が${pending.length}件ある。答え合わせができる状態なら今記録すること: ` +
          `node cli/index.js decision outcome ${pending[0].id} --result met|unmet|unclear`
        );
      }
      lines.push('');
    }
    if (failures.length) {
      lines.push('### 未消化のFailure（同じ穴に落ちるな）');
      for (const f of failures) lines.push(`- ${f.id} [${f.state}] ${f.symptom}`);
      lines.push('');
    }
    if (unknowns.length) {
      lines.push('### 未解決のUnknown');
      for (const u of unknowns) {
        const meta = [];
        if (u.importance !== undefined) meta.push(`importance: ${u.importance}`);
        if (u.blocks.length) meta.push(`blocks: ${u.blocks.join(', ')}`);
        lines.push(`- ${u.id}: ${u.body}${meta.length ? `（${meta.join(' | ')}）` : ''}`);
      }
      lines.push('');
    }
  }
  return {
    lines,
    lessons: lf.lessons,
    excluded: lf.excluded,
    policies,
    decisions,
    past_tasks: pastTasks,
    failures,
    unknowns,
    tokens_est: estimateTokens(lines.join('\n')),
  };
}

// 想起の配信を機械記録する（kind: digest）。tokens_est: 0でないのは、digestは
// briefingと同じく文脈を消費する出力だからである。lessonsは届けた教訓のID —
// 後からconsolidatedのhelped/misledと突き合わせれば「届いたが無視された教訓」が
// 機械記録だけで数えられる（実行者の記憶と自己申告に依存しない）。
function logDigest(osDir, taskId, d) {
  try {
    appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
      ts: nowIso(),
      kind: 'digest',
      task: taskId,
      lessons: (d.lessons || []).map((l) => l.id),
      excluded: (d.excluded || []).map((e) => e.id),
      // 配信した決定のID。後から「届いたのに結果が記録されなかった決定」を
      // 実行者の記憶に頼らず機械記録だけで数えられる（教訓のhelped/misledと同じ配線）
      decisions: (d.decisions || []).map((x) => x.id),
      tokens_est: d.tokens_est || 0,
    });
  } catch {
    // 記録の失敗で想起そのものを止めない
  }
}

module.exports = { recordLesson, lessonsFor, feedback, digest, logDigest };
