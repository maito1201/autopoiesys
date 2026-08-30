#!/usr/bin/env node
'use strict';
// F011の検出器: 「器官が実際に使われたか」を見る層が、壊れたまま緑を出していないか。
//
// agenda の材料 dead_organ は、記録が0件の器官を名指しする（使うか捨てるかは指示しない）。
// この名指しが意味を持つのは、**記録が読めているとき**だけである。壊れた行を黙って
// 読み飛ばせば「0件＝器官が動いていない」と「読めていない」が同じ顔になり、
// 存在しない負債を名指ししたり、本物の破損を見逃したりする
// （F008: 抽出不能を「違反ゼロ」と報告する検出器は、壊れたまま緑を出し続ける）。
//
// 検査は2つ:
//   ① 器官の記録ファイルに壊れた行が無いか（この検出器が自分で走査する）
//   ② 壊れているとき、agenda がそれを警告として出しているか
//      （読み飛ばして「0件」と報告していたらNG。判定は agenda 本体を呼んで行い、
//        fixture の中に判定ロジックの複製は置かない）
//
// 使い方: node scripts/check-dead-organ-audit.js [.osのパス]
const fs = require('node:fs');
const path = require('node:path');

const osDir = path.resolve(process.argv[2] || '.os');
const { agenda } = require(path.join(__dirname, '..', 'core', 'agenda'));

// 器官の記録が載る台帳（agenda側の表と対応する。増やしたらここも足す）
const RECORD_FILES = [
  path.join('observations', 'context_log.jsonl'),
  path.join('observations', 'ledger.jsonl'),
  path.join('observations', 'claim_audit.jsonl'),
];

const violations = [];
const broken = [];
for (const rel of RECORD_FILES) {
  const file = path.join(osDir, rel);
  if (!fs.existsSync(file)) continue; // 未作成は「まだ動いていない」であって破損ではない
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      JSON.parse(s);
    } catch {
      broken.push(`${rel}:${i + 1}`);
    }
  }
}

let r = null;
try {
  r = agenda(osDir);
} catch (e) {
  process.stdout.write(`NG: agendaが実行できない: ${e.message}\n`);
  process.exit(1);
}
const organWarnings = r.warnings.filter((w) => w.includes('動いていない器官'));
const dead = r.items.filter((i) => i.kind === 'dead_organ');

if (broken.length) {
  violations.push(
    `NG: 器官の記録に壊れた行がある（${broken.slice(0, 5).join(', ')}${broken.length > 5 ? ' 他' : ''}）。`
    + 'この状態では器官が動いていないのか記録が読めていないのかを区別できない'
  );
  if (!organWarnings.length) {
    violations.push(
      'NG: agenda が壊れた記録を警告していない（読み飛ばして0件と数えている）。'
      + '「記録が無い」と「記録が読めない」を同じ顔にしてはならない'
    );
  }
  if (dead.length) {
    violations.push(`NG: 記録が読めないのに器官を「動いていない」と名指ししている: ${dead.map((d) => d.ref).join(', ')}`);
  }
}

// 名指しは事実の開示であって指示ではない。記録の在り処と次の一手が無ければ開示になっていない
for (const d of dead) {
  if (!d.why || !d.action) violations.push(`NG: ${d.ref} に「記録の在り処」か「次の一手」が無い`);
}

for (const v of violations) process.stdout.write(v + '\n');
if (violations.length) {
  process.stdout.write(`\n違反 ${violations.length}件。器官の可用性を見る層が信用できない（F011）\n`);
  process.exit(1);
}
process.stdout.write(
  `ok: 器官の記録は全て読める。動いていない器官の名指し${dead.length}件`
  + (dead.length ? `（${dead.map((d) => d.ref).join(', ')}）` : '') + '\n'
);
process.exit(0);
