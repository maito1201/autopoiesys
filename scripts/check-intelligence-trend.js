#!/usr/bin/env node
'use strict';
// sc-005の検出器（F005由来、F007で作り直し）: 知性のoutcome基準。
// 「同一類型の試行系列が3つ以上の文脈（セッション）にまたがり、差し戻し+FAILが
// 後半で増えていない」を検査する。
//
// **断面は暦日ではなく文脈境界である（F007の教訓）。** 経験再利用の検証で効く変数は
// 「会話履歴を共有しない別プロセスか」であり、日付が変わったかではない。
// 10分後の新セッションは明日のセッションと証拠として等価。
// 文脈は observations/sessions.jsonl への `session begin` 宣言で区切られ、
// 各記録はtsで文脈に割り当てられる。宣言を忘れると文脈が過少計上され
// この検査は不合格側に倒れる — 偽の知性を作る方向には壊れない。
//
// 基質（複数文脈の運用）が無い間は必ず不合格になり、それが正しい。
// evaluator側の fail_reason: insufficient_sample により「直せ」ではなく
// 「文脈を重ねて測れ（COLLECT_EVIDENCE）」へ写る。
//
// core非依存の単体実装（golden fixtureに台帳ファイルだけで完結させるため）。
// 使い方: node scripts/check-intelligence-trend.js [.osのパス]
const fs = require('node:fs');
const path = require('node:path');

const osDir = path.resolve(process.argv[2] || '.os');
const MIN_ATTEMPTS = 3;
const MIN_SESSIONS = 3;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// 文脈の割り当て: ts以前にある session begin の件数がセッション番号。
// 最初の宣言より前の記録はすべて文脈0（宣言以前の時代）に落ちる
const begins = readJsonl(path.join(osDir, 'observations', 'sessions.jsonl'))
  .map((r) => r.ts).filter(Boolean).sort();
function sessionOf(ts) {
  let n = 0;
  for (const b of begins) { if (b <= ts) n++; else break; }
  return n;
}

const merged = {};
const createdTs = {};
for (const r of readJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'))) {
  if (!r || !r.id) continue;
  if (!(r.id in merged)) createdTs[r.id] = r.ts;
  merged[r.id] = { ...(merged[r.id] || {}), ...r };
}

const failsByTask = {};
for (const v of readJsonl(path.join(osDir, 'evaluations', 'log.jsonl'))) {
  if (v.verdict === 'FAIL' && v.task) failsByTask[v.task] = (failsByTask[v.task] || 0) + 1;
}
for (const f of readJsonl(path.join(osDir, 'failures', 'ledger.jsonl'))) {
  if (f.state === 'reported' && f.task) failsByTask[f.task] = (failsByTask[f.task] || 0) + 1;
}

const byClass = {};
for (const id of Object.keys(merged).sort((a, b) => {
  const ta = createdTs[a] || ''; const tb = createdTs[b] || '';
  return ta !== tb ? (ta < tb ? -1 : 1) : (a < b ? -1 : 1);
})) {
  const t = merged[id];
  if (!t.class_fp) continue;
  // 取り下げたタスク（誤登録）は試行ではない（F013）。core/growth.js と同じ規律を
  // ここにも置く — 系列の実装が2つあり、sc-005 に束縛されているのはこちらである
  if (t.status === 'withdrawn') continue;
  (byClass[t.class_fp] = byClass[t.class_fp] || { class: t.class, attempts: [] }).attempts.push({
    id, session: sessionOf(String(createdTs[id] || '')), bad: failsByTask[id] || 0,
  });
}

let mature = 0;
let pass = 0;
const worsening = [];
for (const fp of Object.keys(byClass).sort()) {
  const { class: cls, attempts } = byClass[fp];
  const sessions = new Set(attempts.map((a) => a.session)).size;
  if (attempts.length < MIN_ATTEMPTS || sessions < MIN_SESSIONS) {
    process.stdout.write(`ok: ${cls} — 試行${attempts.length}回・${sessions}文脈。基質が足りず判定対象外\n`);
    continue;
  }
  mature++;
  // 前半と後半の差し戻し+FAILの合計を比較する（中央で二分。奇数は前半が1つ多い）
  const mid = Math.ceil(attempts.length / 2);
  const first = attempts.slice(0, mid).reduce((s, a) => s + a.bad, 0);
  const second = attempts.slice(mid).reduce((s, a) => s + a.bad, 0);
  if (second > first) {
    worsening.push(`${cls}: 後半の差し戻し+FAIL ${second} > 前半 ${first}`);
  } else {
    pass++;
    process.stdout.write(`ok: ${cls} — ${attempts.length}試行・${sessions}文脈、後半${second} ≤ 前半${first}\n`);
  }
}

if (worsening.length) {
  for (const w of worsening) process.stdout.write(`NG: ${w}\n`);
  process.stdout.write('\n不合格: 系列が悪化している類型がある。ループが機能していない兆候として調査せよ\n');
  process.exit(1);
}
if (!mature) {
  process.stdout.write(
    `NG: ${MIN_ATTEMPTS}試行以上かつ${MIN_SESSIONS}文脈以上にまたがる類型が1件も無い。\n` +
    '知性のoutcomeは現時点で原理的に測定できない（基質＝複数文脈の運用が存在しない）。\n' +
    '不合格を消す方法は、文脈（セッション）を重ねて運用すること以外に無い\n'
  );
  process.exit(1);
}
process.stdout.write(`\n合格: 判定対象${mature}類型すべてで後半が前半以下\n`);
