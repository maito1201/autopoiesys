'use strict';
// agenda: 「指示なしで次の仕事を出す」器官。
// 人間に聞かなくても、OSの状態（未解決のUnknown・未消化のFailure・反証された教訓・
// 蒸留されていない完了タスク・測れていない成功基準・残っている提案）から、
// 次にやるべき仕事を決定的に並べて返す。LLMは呼ばない — 材料の収集も優先度づけも
// すべて既存台帳の照合と算術で行う（同じOS状態からは常に同じ並びが出る）。
const fs = require('node:fs');
const path = require('node:path');

// ---- 優先度の重み。この重みは測定に基づかない暫定値（設計時に決めた順序づけの近似）。
// growthの試行系列とlesson feedbackの実測が貯まったら、そこから見直す。
const WEIGHTS = {
  // Unknown: importance(0..1) × (1 + blocks数)。importance未設定の既定値
  unknown_default_importance: 0.3,
  // Failure: 深刻度そのままを優先度にする。severity不明時はmediumに落とす
  failure_severity: { high: 1.0, medium: 0.6, low: 0.3 },
  // 反証された教訓: 害になっている可能性のある知識はFailure(medium)より上に置く
  contested_lesson: 0.7,
  // 完了したのに蒸留されていないタスク: 経験が消える前に回収する
  unconsolidated_task: 0.5,
  // 判定器が接地していない成功基準・制約
  unmeasured_criterion: 0.4,
  // 測って落ちている基準。測っていない基準より確度が高いので上に置く
  // （この重みも測定に基づかない暫定値である）
  unmet_criterion: 0.8,
  // .os/proposals/ に残っている未消化の提案
  proposal: 0.3,
};

// 既に着手されている項目の減衰率。消さずに下げる — 着手したまま放置されている仕事は
// 見え続ける必要があり、かつ未着手の仕事より先に出てはいけない。
const IN_FLIGHT_FACTOR = 0.2;

// failure.js の LEGAL_TRANSITIONS の写し（あちらはexportされておらず、担当外ファイルの
// 変更は配線担当に委ねるため複製する）。failure.js側が変わったらここも同期すること。
const FAILURE_NEXT = {
  reported: ['investigated', 'accepted_risk'],
  investigated: ['classified', 'accepted_risk'],
  classified: ['upgrade_proposed', 'accepted_risk'],
  upgrade_proposed: ['upgrade_proposed（提案の差し替え）', 'implemented', 'accepted_risk'],
};

// Failureの状態ごとの実行可能な次の一手（copy&pasteで動く1行）
function failureAction(f) {
  if (f.state === 'reported') return `/investigate-failure を実行（対象: ${f.id}）`;
  if (f.state === 'investigated') return `node cli/index.js failure transition ${f.id} --to classified --file <fields.json>`;
  if (f.state === 'classified') return `node cli/index.js failure transition ${f.id} --to upgrade_proposed --file <fields.json>`;
  return `/upgrade-os を実行（${f.id} の提案を適用または棄却する）`;
}

// ---- 材料a: type: unknown のStatement（snapshotはretracted/supersededを既に除外している）
function unknownItems(osDir) {
  const snap = require('./store').getSnapshot(osDir);
  const items = [];
  for (const id of snap.indexes.by_type.unknown || []) {
    const st = snap.statements[id];
    const blocks = Array.isArray(st.blocks) ? st.blocks : [];
    const importance = typeof st.importance === 'number' ? st.importance : WEIGHTS.unknown_default_importance;
    items.push({
      kind: 'unknown',
      ref: id,
      why: blocks.length
        ? `この不明が ${blocks.join(', ')} を塞いでいる`
        : 'この不明は何を塞いでいるか未宣言（blocksが空）。まず影響範囲を書け',
      score: importance * (1 + blocks.length),
      action: `node cli/index.js statement supersede ${id} "<調査して分かったこと>" --source <出所>`,
    });
  }
  return items;
}

// ---- 材料b: 未消化のFailure（implemented/accepted_risk以外）
function failureItems(osDir) {
  const failure = require('./failure');
  const items = [];
  for (const f of Object.values(failure.loadFailures(osDir))) {
    if (failure.TERMINAL.includes(f.state)) continue;
    const next = FAILURE_NEXT[f.state] || [];
    const sev = WEIGHTS.failure_severity[f.severity];
    items.push({
      kind: 'failure',
      ref: f.id,
      why: `Failureが${f.state}のまま。次の遷移は ${next.join(' | ')}`,
      score: sev !== undefined ? sev : WEIGHTS.failure_severity.medium,
      action: failureAction(f),
    });
  }
  return items;
}

// ---- 材料c: 反証された教訓（countersのevidenceがsupportsより多いlesson）。
// 辺はsnapshotの統合辺ビュー（links + relationship）で数える — retracted/superseded済みの
// 証拠は現在状態から消えているので、撤回された反証で教訓を引退させることはない。
function contestedLessonItems(osDir) {
  const snap = require('./store').getSnapshot(osDir);
  const edgesIn = snap.indexes.edges_in || {};
  const items = [];
  for (const id of snap.indexes.by_type.lesson || []) {
    const edges = edgesIn[id] || [];
    const supports = edges.filter((e) => e.kind === 'supports').length;
    const counters = edges.filter((e) => e.kind === 'counters').length;
    if (counters <= supports) continue;
    items.push({
      kind: 'contested_lesson',
      ref: id,
      why: `この教訓は外れの記録が上回っている（counters ${counters} > supports ${supports}）。書き直すか引退させるか決めよ`,
      score: WEIGHTS.contested_lesson,
      action: `node cli/index.js statement supersede ${id} "<書き直した教訓>" --source consolidate（引退させるなら --status retracted）`,
    });
  }
  return items;
}

// ---- 材料d: status: done なのに consolidated が無いタスク。
// consolidated はタスク完了時の蒸留記録（taskclass.recordConsolidation が書くフィールド）。
function unconsolidatedTaskItems(osDir) {
  const items = [];
  for (const t of Object.values(require('./evaluate').loadTasks(osDir))) {
    if (t.status !== 'done') continue;
    if (t.consolidated) continue;
    items.push({
      kind: 'unconsolidated_task',
      ref: t.id,
      why: '完了したのに何を学んだか未記録。経験が蒸留されずに消えかけている',
      score: WEIGHTS.unconsolidated_task,
      action: `node cli/index.js task consolidate ${t.id}`,
    });
  }
  return items;
}

// ---- 材料e: goal.yamlの成功基準・制約のうち判定器が接地していないもの
function unmeasuredCriterionItems(osDir) {
  const analysis = require('./gap').gapAnalysis(osDir, { criteriaOnly: true });
  const items = [];
  for (const r of analysis.required) {
    // UNMET（測って不合格）を落とすと、実測した瞬間に未達が次の仕事から消える（F010）
    if (r.classification === 'UNMET') {
      // 「直せ」と「標本を足せ」を取り違えない（E3の写像と同じ規律）。
      // 検出器がinsufficient_sampleを宣言しているなら、手法の作り直しは誤った指示である
      const underpowered = /insufficient_sample/.test(r.why || '');
      items.push({
        kind: 'unmet_criterion',
        ref: r.id,
        why: `この基準は測定した結果、不合格である（${r.why}）`,
        score: WEIGHTS.unmet_criterion,
        action: underpowered
          ? '検出力が足りない。手法を作り直すのではなく、標本・観測（文脈や試行）を重ねる'
          : '不合格の原因を調べて直す（node cli/index.js next-action <対象タスク> で次の一手を得る）',
      });
      continue;
    }
    if (r.classification !== 'MISSING' && r.classification !== 'UNVERIFIED') continue;
    items.push({
      kind: 'unmeasured_criterion',
      ref: r.id,
      why: `この基準は測れていない（${r.classification}: ${r.why}）`,
      score: WEIGHTS.unmeasured_criterion,
      action: r.classification === 'MISSING'
        ? '/build-evaluation-model を実行して evaluator を接地する'
        : '束縛済みevaluatorを一度実行してverdictを残す（node cli/index.js evaluate --task <対象タスク>）',
    });
  }
  return items;
}

// ---- 材料f: .os/proposals/ に残っているファイル（未消化の提案）
// 提案ファイルは適用後も残る（適用の記録であり、消すと履歴が消える）。
// 「ファイルが在る」を「未消化」と読むと、適用済みの提案が永久に次の仕事として
// 出続ける（実測: F005は implemented なのに提案が挙がり続けていた）。
// 消化の判定は Failure 台帳に委ねる — ファイル名の Failure ID か、
// terminal な Failure が proposal 欄でそのファイルを指していれば消化済みとみなす。
// パス区切りの正規化。Failure台帳の proposal 欄はOSのパス区切りで書かれるため
// （Windowsでは 'proposals\F006-evaluator.yaml'）、照合の前に '/' に揃える。
// 区切り文字はソースに直接書かず文字コードで作る（エスケープの読み違いを避ける）。
const SEP = String.fromCharCode(92);
function normalizeSep(v) { return String(v).split(SEP).join('/'); }

function consumedProposals(osDir) {
  const failure = require('./failure');
  const consumed = new Set();
  for (const f of Object.values(failure.loadFailures(osDir))) {
    if (!failure.TERMINAL.includes(f.state)) continue;
    consumed.add(f.id);
    for (const v of [f.proposal, f.proposal_stub]) {
      if (typeof v === 'string') consumed.add(normalizeSep(v));
    }
  }
  return consumed;
}

// ファイル名が指す Failure ID（F005-upgrade.md → F005）。無ければ null
function failureIdOf(name) {
  const m = /F\d{3,}/.exec(name);
  return m ? m[0] : null;
}

function proposalItems(osDir) {
  const dir = path.join(osDir, 'proposals');
  if (!fs.existsSync(dir)) return [];
  const consumed = consumedProposals(osDir);
  const items = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const fid = failureIdOf(ent.name);
    if (fid && consumed.has(fid)) continue;
    let referenced = false;
    for (const c of consumed) {
      if (c.includes(`proposals/${ent.name}`)) { referenced = true; break; }
    }
    if (referenced) continue;
    items.push({
      kind: 'proposal',
      ref: `proposals/${ent.name}`,
      why: fid
        ? `消化されていない提案（${fid} はまだ implemented / accepted_risk ではない）`
        : '消化されていない提案（Failure IDを名に含まないため、消化済みかを機械判定できない）',
      score: WEIGHTS.proposal,
      action: `/upgrade-os を実行して proposals/${ent.name} の適用可否を判断する`,
    });
  }
  return items;
}

// ---- 由来（origin）の機械解決。
// 「何がこの仕事を要求したか」は自己申告の文字列であり、書こうと思えば何でも書ける。
// 自発的推進（sc-007）の証拠がその文字列だけなら、基準は文字列を打つだけで満たせる。
// ここでやるのは **参照の解決**であって、由来の正しさの判定ではない —
// 名指しされた項目がOSの台帳に実在するかどうかだけを見る（開示の検査。内容は強制しない）。
//
// 戻り値: { kind, ref, self_directed, resolved, via, why }
//   self_directed: OSの記録が要求した仕事か（user は false。指示された仕事である）
//   resolved: 名指しされた項目が台帳に実在したか
function resolveOrigin(osDir, origin) {
  const raw = String(origin === undefined || origin === null ? '' : origin).trim();
  if (!raw) return null;
  const i = raw.indexOf(':');
  const kind = (i === -1 ? raw : raw.slice(0, i)).trim();
  const ref = i === -1 ? '' : raw.slice(i + 1).trim();
  const mk = (o) => ({ kind, ref, self_directed: false, resolved: false, ...o });

  if (kind === 'user') {
    // ユーザーの指示は台帳に無い。照合の対象ではないので resolved: true・自発ではない
    return mk({ self_directed: false, resolved: true, via: 'user', why: 'ユーザーの指示（機械照合の対象外。自発的推進の証拠にはならない）' });
  }
  const KNOWN = ['agenda', 'failure', 'lesson', 'unknown'];
  if (!KNOWN.includes(kind)) {
    return mk({ why: `未知の由来種別: ${kind}（使えるのは ${KNOWN.join(' / ')} / user）` });
  }
  if (!ref) return mk({ why: `${kind}: の後に参照が無い（何を指しているかが記録されない）` });

  if (kind === 'agenda') {
    const { items } = agenda(osDir, { resolveOrigins: false });
    const hit = items.find((it) => it.ref === ref);
    if (!hit) {
      return mk({
        self_directed: true,
        why: `agendaに ref=${ref} の項目が無い（現在の項目: ${items.map((it) => it.ref).join(', ') || 'なし'}）`,
      });
    }
    return mk({ self_directed: true, resolved: true, via: `agenda:${hit.kind}`, why: hit.why });
  }
  if (kind === 'failure') {
    const f = require('./failure').loadFailures(osDir)[ref];
    if (!f) return mk({ self_directed: true, why: `Failure台帳に ${ref} が無い` });
    return mk({ self_directed: true, resolved: true, via: `failure:${f.state}`, why: f.symptom || `Failure ${ref}` });
  }
  if (kind === 'lesson' || kind === 'unknown') {
    const st = require('./store').getSnapshot(osDir).statements[ref];
    if (!st) return mk({ self_directed: true, why: `現在状態に ${ref} が無い（撤回・supersede済みか、存在しない）` });
    if (st.type !== kind) return mk({ self_directed: true, why: `${ref} のtypeは ${st.type} であり ${kind} ではない` });
    return mk({ self_directed: true, resolved: true, via: `${kind}:${ref}`, why: st.body || ref });
  }
  /* istanbul ignore next: KNOWNで先に弾いている */
  return mk({ why: `未知の由来種別: ${kind}` });
}

// 未完了タスクが由来として名指ししている項目 → タスクIDの索引。
// これが無いと、着手中の項目が未着手と同じ順位で出続け、「次の仕事」を聞くたびに
// いま自分がやっている仕事を勧められる。
function inFlightRefs(osDir) {
  const map = {};
  for (const t of Object.values(require('./evaluate').loadTasks(osDir))) {
    if (t.status === 'done') continue;
    const ref = t.origin_verified && t.origin_verified.ref;
    if (!ref) continue;
    (map[ref] = map[ref] || []).push(t.id);
  }
  for (const k of Object.keys(map)) map[k].sort();
  return map;
}

// 材料1種の取得失敗で全体を落とさない。壊れた台帳があっても他の材料は返し、
// 何をスキップしたかはwarningsで申告する（黙って欠けるのが一番危ない）。
function collect(warnings, label, fn) {
  try {
    return fn();
  } catch (e) {
    warnings.push(`${label}の収集に失敗（この種だけスキップ）: ${e.message}`);
    return [];
  }
}

// 次にやるべき仕事の一覧。戻り値 { items: [{kind, ref, why, score, action}], warnings: [] }。
// itemsはscore降順・同点はref昇順（決定的な並び）。
function agenda(osDir, { resolveOrigins = true } = {}) {
  const warnings = [];
  const items = [
    ...collect(warnings, 'unknown', () => unknownItems(osDir)),
    ...collect(warnings, 'Failure', () => failureItems(osDir)),
    ...collect(warnings, '反証された教訓', () => contestedLessonItems(osDir)),
    ...collect(warnings, '未蒸留の完了タスク', () => unconsolidatedTaskItems(osDir)),
    ...collect(warnings, '未測定の基準', () => unmeasuredCriterionItems(osDir)),
    ...collect(warnings, '未消化の提案', () => proposalItems(osDir)),
  ];
  // 着手済みの項目は消さずに降格する。resolveOrigins: false は resolveOrigin からの
  // 再入時（agendaを引くためにagendaを引く）に無限再帰を避けるための入口。
  if (resolveOrigins) {
    const flight = collect(warnings, '着手中の項目', () => inFlightRefs(osDir));
    for (const it of items) {
      const tasks = flight[it.ref];
      if (!tasks || !tasks.length) continue;
      it.in_flight = tasks;
      it.score *= IN_FLIGHT_FACTOR;
      it.why = `${it.why} — 既に着手中（${tasks.join(', ')}）`;
    }
  }
  items.sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { items, warnings };
}

// 人が読むMarkdown行配列。上位limit件（既定10）だけを出す — 全件を並べると
// 「一覧を読む」が次の仕事になってしまう。
function agendaReport(osDir, { limit = 10 } = {}) {
  const { items, warnings } = agenda(osDir);
  const lines = ['## 次にやるべき仕事（OSの状態から機械的に導出。優先度は決定的な近似）', ''];
  if (items.length === 0) {
    lines.push('未処理の仕事は無い。新しいタスクか、golden taskの拡充を検討せよ');
  } else {
    const top = items.slice(0, limit);
    top.forEach((it, i) => {
      lines.push(`${i + 1}. [${it.score.toFixed(2)}] ${it.kind} ${it.ref} — ${it.why}`);
      lines.push(`   → ${it.action}`);
    });
    if (items.length > top.length) {
      lines.push('');
      lines.push(`（他 ${items.length - top.length} 件）`);
    }
  }
  if (warnings.length) {
    lines.push('');
    for (const w of warnings) lines.push(`警告: ${w}`);
  }
  return lines;
}

module.exports = { agenda, agendaReport, resolveOrigin, WEIGHTS, IN_FLIGHT_FACTOR };
