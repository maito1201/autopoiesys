#!/usr/bin/env node
'use strict';
// sc-006の検出器（F006由来: 経験再利用C2の憲章束縛）。
// 「前の文脈で生まれた教訓が、後の文脈のdigestで配信された」機械記録が存在するかを検査する。
//
// 配信（kind:digest）はOS自身の記録であり、実行者の自己申告（helped/misled）に依存しない —
// 「効いたか」はsc-005の系列が答え、ここは「文脈を跨いで経験が届いた」事実だけを見る。
// 同一文脈内の配信は数えない（実行者の作業記憶で説明できてしまい、OS経由の再利用の
// 証拠にならない。F007の教訓: 区別を作るのは文脈境界である）。
//
// 使い方: node scripts/check-experience-reuse.js [.osのパス]
const fs = require('node:fs');
const path = require('node:path');

const osDir = path.resolve(process.argv[2] || '.os');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const begins = readJsonl(path.join(osDir, 'observations', 'sessions.jsonl'))
  .map((r) => r.ts).filter(Boolean).sort();
function sessionOf(ts) {
  let n = 0;
  for (const b of begins) { if (b <= ts) n++; else break; }
  return n;
}

// 教訓の誕生文脈（events.jsonlのlesson行のts。supersede追跡は不要 — 誕生時刻だけ要る）
const bornSession = {};
for (const e of readJsonl(path.join(osDir, 'world_model', 'events.jsonl'))) {
  if (e.type === 'lesson' && e.id && e.ts) bornSession[e.id] = sessionOf(e.ts);
}

let deliveries = 0;
let crossDeliveries = 0;
const examples = [];
for (const c of readJsonl(path.join(osDir, 'observations', 'context_log.jsonl'))) {
  if (c.kind !== 'digest' || !Array.isArray(c.lessons)) continue;
  const dSession = sessionOf(c.ts);
  for (const id of c.lessons) {
    deliveries++;
    if (id in bornSession && bornSession[id] < dSession) {
      crossDeliveries++;
      if (examples.length < 5) {
        examples.push(`${id}（文脈${bornSession[id]}で誕生 → 文脈${dSession}の${c.task || '?'}へ配信）`);
      }
    }
  }
}

process.stdout.write(`ok: 配信${deliveries}件、うち文脈を跨いだ配信${crossDeliveries}件\n`);
for (const e of examples) process.stdout.write(`ok: ${e}\n`);
if (!crossDeliveries) {
  process.stdout.write(
    'NG: 文脈を跨いだ経験の配信が1件も無い。\n' +
    '教訓が生まれた文脈の中でしか使われておらず、OS経由の経験再利用はまだ観測されていない。\n' +
    '新しい文脈（session begin後）で同種のタスクを回すことでしか、この記録は生まれない\n'
  );
  process.exit(1);
}
process.stdout.write('\n合格: OSが文脈を跨いで経験を届けた機械記録が存在する\n');
