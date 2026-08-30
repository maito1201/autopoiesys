'use strict';
// agenda: 「指示なしで次の仕事を出す」器官。
// 人間に聞かなくても、OSの状態（未解決のUnknown・未消化のFailure・反証された教訓・
// 蒸留されていない完了タスク・測れていない成功基準・残っている提案）から、
// 次にやるべき仕事を決定的に並べて返す。LLMは呼ばない — 材料の収集も優先度づけも
// すべて既存台帳の照合と算術で行う（同じOS状態からは常に同じ並びが出る）。
const fs = require('node:fs');
const path = require('node:path');
const { readJsonl } = require('./util');

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
  // 一度も動いていない器官。事実の開示であって仕事の指示ではないので、
  // 未消化の提案と同じ最下層に置く（見え続けるが、他を押しのけない）
  dead_organ: 0.3,
  // 完了したタスクで下したのに結果が未記録の決定。放置すると決定層は帳簿のまま
  // 経験にならないが、単発の答え合わせは未消化のFailureより軽い
  unreviewed_decision: 0.45,
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

// ---- 材料e': 完了したタスクで下したのに結果が未記録の決定。
// 「決めた通りになったか」を照合するループ（CONCEPT §8）は、この照合が行われて初めて閉じる。
function unreviewedDecisionItems(osDir) {
  const tasksById = require('./evaluate').loadTasks(osDir);
  const byFp = require('./policy').foldByFingerprint(osDir);
  const items = [];
  for (const fp of Object.keys(byFp).sort()) {
    const b = byFp[fp];
    for (const d of b.decisions) {
      if (!d.task || d.outcomes.length) continue;
      const t = tasksById[d.task];
      if (!t || t.status !== 'done') continue;
      items.push({
        kind: 'unreviewed_decision',
        ref: d.id,
        why: `「${b.situation}」で${d.chosen ? `「${d.chosen}」を選んだ` : '決めた'}が、期待どおりになったか未記録（${d.task} は完了済み）`,
        score: WEIGHTS.unreviewed_decision,
        action: `node cli/index.js decision outcome ${d.id} --result met|unmet|unclear --note "<何が起きたか>"`,
      });
    }
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

// ---- 材料h: 一度も動いていない器官（F011）。
//
// F011の why_undetected は「器官が正しく動くか」（テスト・golden）と「成果物が要件を
// 満たすか」（evaluator）の2層はあるのに、**「器官が実際に使われたか」を見る層が無い**
// というものだった。decision/policy は単体テスト全件PASSで、テストの中では閉ループが
// 成立していた。実運用の記録（policy.active=0 / hits=0 / outcome 0件）は metrics に
// 出ていたが、ゼロを問題として名指しする経路が無く、3文脈・15タスクのあいだ誰も読まなかった。
//
// **強制はしない。** 出すのは「この器官は一度も動いていない」という事実だけで、
// 「だから使え」とも「だから消せ」とも言わない。使われない器官は資産ではなく負債だが、
// 負債の返し方は「使う」と「捨てる」の両方があり、どちらを選ぶかはコアが決めることではない
// （S0018: 検出器は内容を強制せず開示だけを強制する）。
//
// 表に載せるのは **設計上、通常運用で必ず記録が生じるはずの器官だけ**である。
// 正当に0件でありうるもの（research 等）は載せない — 誤検出する検出器は無いのと同じか、
// それ以下である。器官を実装した変更が、自分でこの表に1行足すこと。
const ORGANS = [
  {
    id: 'policy',
    what: '方針層（反復した決定を畳み込み、LLM推論なしで選択を返す）',
    where: 'rules/policy-*.yaml',
    zero_means: '決定が一度も方針に畳み込まれていない',
    next: 'node cli/index.js decision outcome <S00xx> --result met|unmet で結果を記録し、再来を待つ',
  },
  {
    id: 'policy_hit',
    what: '方針の発火（想起をLLMなしで返した回数）',
    where: 'observations/context_log.jsonl の kind: policy_hit',
    zero_means: '方針が存在しても、実行者が判断の前に引いていない',
    next: 'run-task 手順2の decision recall / policy match を判断のたびに通す',
  },
  {
    id: 'decision_outcome',
    what: '決定の結果照合（決めた通りになったかを見るループ）',
    where: 'world_model の type: decision に記録された outcome',
    zero_means: '決定が帳簿のままで、経験になっていない（F011の症状そのもの）',
    next: 'node cli/index.js decision outcome <S00xx> --result met|unmet|unclear',
  },
  {
    id: 'measured_tokens',
    what: 'Token Ledgerの実測（見積りでない消費の記録）',
    where: 'observations/costs.jsonl の estimated: false',
    zero_means: 'コスト判断の材料が全件見積りで、削減の主張を実測で検証できない',
    next: 'ledger add に --tokens-in/--tokens-out --measured を付けられる経路を作る',
  },
  {
    id: 'delivered_context',
    what: '実行側へのReasoning Context配布（context コマンド）',
    where: 'observations/context_log.jsonl の kind: context',
    zero_means: '最小Subgraphが判定者専用のままで、実行側・サブエージェントに配られていない',
    next: 'node cli/index.js context --task <id> --purpose "<委ねる仕事>"',
  },
  {
    id: 'claim_audit',
    what: '蒸留申告の独立監査（helped/misled を台帳と突き合わせる）',
    where: 'observations/claim_audit.jsonl',
    zero_means: '申告が申告者自身のまま確定していて、経験再利用の主張に裏づけが無い',
    next: 'node cli/index.js experience audit <task> を回し、別文脈の判定者に記録させる',
  },
];

// 器官の記録を数える。**読めなかったことを0件と混同しない**（F008の教訓:
// 抽出不能を「違反ゼロ」と報告する検出器は、壊れたまま緑を出し続ける）。
// 数えられなかった器官は例外にして、agendaのwarningsに出す。
function countOrganRecords(osDir, organ) {
  const countJsonl = (file, pred) => {
    const p = path.join(osDir, file);
    if (!fs.existsSync(p)) return 0; // 未作成は「まだ動いていない」であって異常ではない
    const text = fs.readFileSync(p, 'utf8');
    let n = 0;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let row;
      try {
        row = JSON.parse(s);
      } catch {
        throw new Error(`${file} に壊れた行がある（読めない記録を0件と数えない）`);
      }
      if (!pred || pred(row)) n++;
    }
    return n;
  };
  if (organ.id === 'policy') {
    const dir = path.join(osDir, 'rules');
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => /^policy-.*\.ya?ml$/.test(f)).length;
  }
  if (organ.id === 'policy_hit') {
    return countJsonl(path.join('observations', 'context_log.jsonl'), (r) => r.kind === 'policy_hit');
  }
  if (organ.id === 'decision_outcome') {
    // 結果は decision を書き換えず、type: outcome の別Statementとして追記される
    // （SCHEMA.md: レビューは元のdecisionをsupersedeせず、outcomeを追記して derived_from で張る）。
    // decision側の outcome フィールドを数えると、記録が積み上がっても永久に0件になる
    const snap = require('./store').getSnapshot(osDir);
    return (snap.indexes.by_type.outcome || [])
      .filter((id) => snap.statements[id] && snap.statements[id].result).length;
  }
  if (organ.id === 'measured_tokens') {
    // 台帳の実体は costs.jsonl である（ledger.jsonl は存在しない）。
    // 存在しないファイルを見ていたため、この器官は何を記録しても永久に0件だった
    return countJsonl(path.join('observations', 'costs.jsonl'), (r) => r.estimated === false);
  }
  if (organ.id === 'delivered_context') {
    return countJsonl(path.join('observations', 'context_log.jsonl'), (r) => r.kind === 'context');
  }
  if (organ.id === 'claim_audit') {
    return countJsonl(path.join('observations', 'claim_audit.jsonl'));
  }
  throw new Error(`器官の数え方が未定義: ${organ.id}`);
}

function deadOrganItems(osDir) {
  // まだ一度も仕事を完了していないOSでは、器官が動いていないのは当たり前である。
  // 表に載せた器官はどれも run-task のループを1周すれば記録が生じるものなので、
  // 「1周した後も0件」を条件にする（初日のOSに6件の負債を並べても、事実を薄めるだけ）
  const tasks = {};
  for (const r of readJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'))) {
    if (r && r.id) tasks[r.id] = { ...(tasks[r.id] || {}), ...r };
  }
  if (!Object.values(tasks).some((t) => t.status === 'done' || t.last_action === 'DONE')) return [];
  const items = [];
  const failed = [];
  for (const organ of ORGANS) {
    let n;
    try {
      n = countOrganRecords(osDir, organ);
    } catch (e) {
      failed.push(`${organ.id}: ${e.message}`);
      continue;
    }
    if (n > 0) continue;
    items.push({
      kind: 'dead_organ',
      ref: `organ/${organ.id}`,
      why: `${organ.what}の記録が0件（${organ.where}）— ${organ.zero_means}。`
        + '使うか捨てるかはこちらでは決めない',
      score: WEIGHTS.dead_organ,
      action: organ.next,
    });
  }
  // 数えられなかった器官は黙って落とさない。抽出不能を「動いている」とも「0件」とも読まない
  if (failed.length) throw new Error(`器官の記録を数えられない: ${failed.join(' / ')}`);
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
    ...collect(warnings, '結果未記録の決定', () => unreviewedDecisionItems(osDir)),
    ...collect(warnings, '未消化の提案', () => proposalItems(osDir)),
    ...collect(warnings, '動いていない器官', () => deadOrganItems(osDir)),
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
