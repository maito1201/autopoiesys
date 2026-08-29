'use strict';
// 申告の独立監査（S0035）。
//
// consolidate の helped/misled は、申告者＝実行者のまま台帳に載る。
// 「効いた」と書けば効いたことになる構造では、教訓の実績数は自己申告の合計でしかなく、
// 反証された教訓を想起から外す仕組み（experience.lessonsFor）も申告の上に乗っている。
//
// ここで作るのは **判定の中身**ではなく **判定の経路**である:
// 台帳の機械記録だけから監査用briefingを組み、会話履歴を持たない別の判定者に渡す。
// 何が真かを機械が決めるのではない（S0018: 検出器は内容を強制せず開示だけを強制する）。
//
// 独立性の限界: 判定者は同じモデル・同じ実行環境の別文脈である。記録の外に出た
// 独立性（人間・別系統の記録）ではない。この限界は briefing 本文にも書く。
const path = require('node:path');
const store = require('./store');
const { readJsonl, appendJsonl, atomicWriteFile, estimateTokens, nowIso } = require('./util');

const AUDIT_RESULTS = ['supported', 'contradicted', 'insufficient'];

function claimAuditFile(osDir) {
  return path.join(osDir, 'observations', 'claim_audit.jsonl');
}

function readJsonlSafe(file) {
  try {
    return readJsonl(file);
  } catch {
    return [];
  }
}

// 監査に渡す材料をすべて台帳から集める。ここに入らないもの（完了報告の散文・
// 会話の記憶・実行者の説明）は判定者に届かない — それが独立性の実体である。
function auditMaterial(osDir, taskId) {
  const evaluate = require('./evaluate');
  const task = evaluate.getTask(osDir, taskId);
  const claim = task.consolidated || null;
  const snapshot = store.getSnapshot(osDir);
  const delivered = [];
  for (const c of readJsonlSafe(path.join(osDir, 'observations', 'context_log.jsonl'))) {
    if (c.kind === 'digest' && c.task === taskId) {
      delivered.push({ ts: c.ts, lessons: c.lessons || [], excluded: c.excluded || [] });
    }
  }
  const claimed = [];
  // unapplied も監査対象に含める（「本当に適用場面が無かったのか」を台帳から見られるように。
  // これが無いと unapplied は misled と言わずに済む逃げ道になる）
  const roles = [
    ['helped', (claim && claim.helped) || []],
    ['misled', (claim && claim.misled) || []],
    ['unapplied', (claim && claim.unapplied) || []],
  ];
  for (const [role, ids] of roles) {
    for (const id of ids) {
      const st = snapshot.statements[id];
      claimed.push({
        lesson: id,
        role,
        body: st ? st.body : '(現在状態に存在しない)',
        when: st ? st.when : undefined,
        delivered_ts: delivered.filter((d) => d.lessons.includes(id)).map((d) => d.ts).sort(),
      });
    }
  }
  return { task, claim, claimed, delivered, verdicts: evaluate.latestVerdicts(osDir, taskId) };
}

// 監査briefingを組んで .os/briefings/ に書く。内容は台帳の機械記録と申告そのものだけ。
function buildClaimAudit(osDir, taskId) {
  const m = auditMaterial(osDir, taskId);
  const t = m.task;
  const L = [];
  L.push(`# 蒸留申告の独立監査: ${t.id}`);
  L.push('');
  L.push('あなたはこのタスクを実行していない。会話の履歴も、完了報告の本文も持っていない。');
  L.push('渡されるのは下の台帳記録と、実行者の申告そのものだけである。');
  L.push('判定するのは「申告が台帳の記録と整合するか」であって、教訓の正しさではない。');
  L.push('');
  L.push('**記録に現れないものは contradicted ではなく insufficient と判定せよ。**');
  L.push('台帳に無いことは「起きなかった」ことを意味しない（台帳は行動の一部しか写さない）。');
  L.push('contradicted は、記録が申告と**食い違う**ときにだけ使う。');
  L.push('');
  L.push('## タスク（台帳）');
  L.push(`- id: ${t.id}`);
  L.push(`- objective: ${t.objective}`);
  L.push(`- class: ${t.class || '(なし)'}`);
  L.push(`- origin: ${t.origin || '(未記録)'}${t.origin_verified ? ` → 解決済み ${t.origin_verified.via}` : ''}`);
  L.push(`- status: ${t.status}`);
  L.push('');
  L.push('## 実行者の申告（これが判定対象）');
  if (!m.claim) {
    L.push('- 蒸留がまだ記録されていない（監査対象が無い）');
  } else {
    L.push(`- lessons（生まれた教訓）: ${(m.claim.lessons || []).join(', ') || 'なし'}`);
    L.push(`- helped（効いたと申告）: ${(m.claim.helped || []).join(', ') || 'なし'}`);
    L.push(`- misled（外れたと申告）: ${(m.claim.misled || []).join(', ') || 'なし'}`);
    if (m.claim.unapplied && m.claim.unapplied.length) {
      L.push(`- unapplied（適用しなかったと申告）: ${m.claim.unapplied.join(', ')} — 理由: ${m.claim.unapplied_reason || '(未記載)'}`);
    }
    if (m.claim.none_learned) L.push(`- none_learned: ${m.claim.none_learned}`);
    if (m.claim.note) L.push(`- note: ${m.claim.note}`);
  }
  L.push('');
  L.push('## 申告された各教訓（本文と、配信の機械記録）');
  if (!m.claimed.length) {
    L.push('- helped/misled の申告なし');
  } else {
    for (const c of m.claimed) {
      L.push(`### ${c.lesson}（申告: ${c.role}）`);
      L.push(`- 教訓: ${c.body}`);
      if (c.when) L.push(`- 適用条件: ${c.when}`);
      L.push(`- このタスクへの配信記録: ${c.delivered_ts.length ? c.delivered_ts.join(', ') : 'なし（届いていない教訓を効いたと申告している）'}`);
      L.push('');
    }
  }
  L.push('## 台帳の機械記録（時刻つき）');
  L.push('');
  L.push('### 手順の事前固定（plans）');
  for (const p of t.plans || []) L.push(`- ${p.ts} ${p.path} sha256=${String(p.hash).slice(0, 12)}`);
  if (!(t.plans || []).length) L.push('- なし');
  L.push('');
  L.push('### 成果物の登録（artifacts）');
  for (const a of t.artifacts || []) L.push(`- ${a.ts} ${a.path}${a.note ? ` — ${a.note}` : ''}`);
  if (!(t.artifacts || []).length) L.push('- なし');
  L.push('');
  L.push('### チェックポイント（notes）');
  for (const n of t.notes || []) L.push(`- ${n.ts} ${n.note}`);
  if (!(t.notes || []).length) L.push('- なし');
  L.push('');
  L.push('### 評価のverdict（evaluatorごとの最新）');
  const evIds = Object.keys(m.verdicts).sort();
  for (const e of evIds) {
    const v = m.verdicts[e];
    L.push(`- ${v.ts} ${e}: ${v.verdict}${v.reason ? `（reason: ${v.reason}）` : ''}`);
  }
  if (!evIds.length) L.push('- なし');
  L.push('');
  L.push('### 想起の配信ログ（digest）');
  for (const d of m.delivered) {
    L.push(`- ${d.ts} 配信: ${d.lessons.join(', ') || 'なし'}${d.excluded.length ? ` / 反証で除外: ${d.excluded.join(', ')}` : ''}`);
  }
  if (!m.delivered.length) L.push('- なし');
  L.push('');
  L.push('## 判定の限界（読む前に承知すること）');
  L.push('- あなたは実行者と同じモデル・同じ環境の別文脈である。記録の外に出た独立性ではない');
  L.push('- 台帳は行動の一部しか写さない。写っていない行動は判定の材料にならない');
  L.push('');
  L.push('## 記録方法');
  L.push('申告された教訓1件ごとに、次のコマンドで結果を記録せよ:');
  L.push('');
  L.push(`    node cli/index.js experience audit-record ${t.id} --lesson <S00xx> --result supported|contradicted|insufficient --note "<根拠にした記録>"`);
  L.push('');
  L.push('contradicted を記録すると、consolidate が書いた申告の極性辺（helpedの支持 /');
  L.push('misledの反証）が撤回される。教訓そのものに新しい反証は張られない — 罰するのは');
  L.push('申告であって教訓ではない。supported は監査の事実だけを記録する');
  L.push('（裏づけを二重に数えないため、新しい支持辺は張らない）。');

  const file = path.join(osDir, 'briefings', `claim-audit-${t.id}.md`);
  const text = L.join('\n') + '\n';
  atomicWriteFile(file, text);
  // 監査briefingも文脈を消費する出力なので、他のbriefingと同じ台帳に載せる
  appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
    ts: nowIso(),
    kind: 'claim_audit_briefing',
    task: t.id,
    tokens_est: estimateTokens(text),
  });
  return { file, lines: L, claimed: m.claimed, tokens_est: estimateTokens(text) };
}

// 監査結果の記録。contradicted のときだけ台帳の極性を動かす。
function recordClaimAudit(osDir, { task, lesson, result, note, source } = {}) {
  if (!task) throw new Error('taskが必要（どのタスクの申告を監査したか）');
  if (!lesson) throw new Error('lessonが必要（監査対象の教訓ID）');
  if (!AUDIT_RESULTS.includes(result)) {
    throw new Error(`resultは ${AUDIT_RESULTS.join(' | ')} のいずれか`);
  }
  const snapshot = store.getSnapshot(osDir);
  const st = snapshot.statements[lesson];
  if (!st) throw new Error(`教訓が現在状態に存在しない: ${lesson}`);
  if (st.type !== 'lesson') throw new Error(`${lesson} はtype: lessonではない（${st.type}）`);
  const src = source || 'experience-audit';
  const retracted = [];
  const added = [];
  if (result === 'contradicted') {
    // 申告に基づく極性辺（helpedのsupports / misledのcounters）を撤回する。
    // 撤回しないと、偽の申告の極性が実績として数えられ続け、申告が偽だった事実が消える。
    //
    // **教訓への新しいcountersは張らない（F009）。** 罰するのは申告であって教訓ではない —
    // 実行者の虚偽申告のせいで正しい教訓が反証で引退した実例がある（S0061:
    // 「行動のたびにtask noteを残した」という申告がnotes空と食い違い、contradictedの
    // countersがS0061自体に張られて想起から除外された。外れたのは申告である）。
    // 虚偽申告の事実は claim_audit.jsonl の行と、撤回されたevidenceの本文に残る。
    for (const l of (snapshot.indexes.links_in || {})[lesson] || []) {
      const ev = snapshot.statements[l.from];
      if (!ev || ev.type !== 'evidence') continue;
      if (l.role !== 'supports' && l.role !== 'counters') continue;
      if ((ev.provenance || {}).task !== task) continue;
      // 監査自身が書いた反証（過去のcontradictedの誤配線を含む）は撤回対象にしない
      if ((ev.provenance || {}).source === src) continue;
      store.recordStatement(osDir, {
        supersedes: ev.id,
        body: `${ev.body}（独立監査で撤回: 台帳の記録が申告と食い違う${note ? ` — ${note}` : ''}）`,
        status: 'retracted',
        source: src,
        task,
      });
      retracted.push(ev.id);
    }
  }
  const row = { ts: nowIso(), task, lesson, result, source: src };
  if (note) row.note = note;
  appendJsonl(claimAuditFile(osDir), row);
  return { ...row, retracted, added };
}

// 監査結果（task/lessonごとの最新1件）。taskId省略で全件
function claimAudits(osDir, taskId) {
  const latest = {};
  for (const r of readJsonlSafe(claimAuditFile(osDir))) {
    if (taskId && r.task !== taskId) continue;
    latest[`${r.task}/${r.lesson}`] = r;
  }
  return Object.values(latest).sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

// 申告と監査の突き合わせ集計。growth/metricsが「申告」と「独立検証」を分けて出すための材料。
// 分母を必ず併記する（S0033: 合計値だけの系列を成長の証拠にしない）。
function auditCoverage(osDir) {
  const tasks = require('./evaluate').loadTasks(osDir);
  const audits = claimAudits(osDir);
  const byKey = {};
  for (const a of audits) byKey[`${a.task}/${a.lesson}`] = a.result;
  let claimed = 0;
  let audited = 0;
  const byResult = { supported: 0, contradicted: 0, insufficient: 0 };
  for (const t of Object.values(tasks)) {
    const c = t.consolidated;
    if (!c) continue;
    for (const id of [...(c.helped || []), ...(c.misled || []), ...(c.unapplied || [])]) {
      claimed++;
      const r = byKey[`${t.id}/${id}`];
      if (!r) continue;
      audited++;
      if (byResult[r] !== undefined) byResult[r]++;
    }
  }
  return { claimed, audited, by_result: byResult };
}

module.exports = {
  AUDIT_RESULTS,
  auditMaterial,
  buildClaimAudit,
  recordClaimAudit,
  claimAudits,
  auditCoverage,
};
