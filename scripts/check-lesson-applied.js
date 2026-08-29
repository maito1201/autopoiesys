#!/usr/bin/env node
'use strict';
// sc-008の検出器（F009 / goal監査003由来: 「記憶と経験を再利用して」の「適用」の憲章束縛）。
//
// sc-006（experience_reuse）は配信の機械記録を見るが、配信は適用を意味しない —
// 教訓が配信され適用場面もあったのに適用されず、報告が誤った実例が2件ある（F009）。
// ここでは「helped の申告のうち、独立監査で supported と判定された実績が1件以上あるか」を
// 検査する。適用の証拠は**申告ではなく監査記録**（claim_audit.jsonl）で数える。
//
// 申告の真偽を機械が決めるのではない（監査の判定は別文脈の判定者が行う）。
// この検出器は監査記録の存在を数えるだけである。
//
// 使い方: node scripts/check-lesson-applied.js [.osのパス]
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

// task/lessonごとの最新の監査結果
const latest = {};
for (const r of readJsonl(path.join(osDir, 'observations', 'claim_audit.jsonl'))) {
  if (r && r.task && r.lesson) latest[`${r.task}/${r.lesson}`] = r;
}
const rows = Object.values(latest);
const supported = rows.filter((r) => r.result === 'supported');
const contradicted = rows.filter((r) => r.result === 'contradicted');

process.stdout.write(`ok: 監査記録${rows.length}件（supported ${supported.length} / contradicted ${contradicted.length} / insufficient ${rows.length - supported.length - contradicted.length}）\n`);
for (const r of supported.slice(0, 5)) process.stdout.write(`ok: ${r.task}/${r.lesson} supported（${r.ts}）\n`);
if (!supported.length) {
  process.stdout.write(
    'NG: 独立監査で supported と判定された「効いた」の実績が1件も無い。\n'
    + '経験の適用は申告のままで、台帳から裏づけられた再利用がまだ存在しない。\n'
    + 'task consolidate で申告し、experience audit → audit-record の監査を通すことでしか、この記録は生まれない\n'
  );
  process.exit(1);
}
process.stdout.write('\n合格: 独立監査で裏づけられた経験の適用実績が存在する\n');
