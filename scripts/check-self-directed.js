#!/usr/bin/env node
'use strict';
// sc-007の検出器（F006由来: 自発的推進C4の憲章束縛）。
// 「OS自身が要求した仕事（origin が agenda:/failure:/lesson:/unknown: のタスク）が完了した実績」が
// 存在するかを検査する。origin: user しか無いなら、装置は指示されたときだけ動いている。
//
// 数えるのは **登録時にOSの台帳へ解決できた由来だけ**（tasks.jsonl の origin_verified）。
// 接頭辞つきの文字列を打つだけで合格する検査は、自発的推進の証拠にならない —
// 由来の文字列は実行者が自由に書けるからである。解決は task new が登録時に行い、
// 結果を焼き込む（後でその項目が解決・消滅しても、要求された事実は残る）。
//
// 強制しているのは参照の解決可能性であって、由来の正しさではない（開示の検査であり、
// どの仕事をすべきかを機械が決めるのではない）。
//
// 使い方: node scripts/check-self-directed.js [.osのパス]
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

const merged = {};
for (const r of readJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'))) {
  if (r && r.id) merged[r.id] = { ...(merged[r.id] || {}), ...r };
}

const SELF = /^(agenda:|failure:|lesson:|unknown:)/;
const all = Object.values(merged);
// 解決済み（機械記録）と、接頭辞だけの申告（未検証）を分けて数える。
// 未検証を黙って捨てない — 「申告はあるが解決されていない」こと自体が見えるべき情報である
const verified = all.filter((t) => t.origin_verified && t.origin_verified.ref);
const claimedOnly = all.filter((t) => !t.origin_verified && SELF.test(String(t.origin || '')));
const doneVerified = verified.filter((t) => t.status === 'done');

process.stdout.write(
  `ok: タスク${all.length}件、origin開示あり${all.filter((t) => t.origin).length}件、`
  + `解決済みのOS由来${verified.length}件（完了${doneVerified.length}件）、未検証の申告${claimedOnly.length}件\n`
);
for (const t of doneVerified.slice(0, 5)) {
  process.stdout.write(`ok: ${t.id}（${t.origin} → ${t.origin_verified.via}）done\n`);
}
for (const t of claimedOnly.slice(0, 5)) {
  process.stdout.write(`注記: ${t.id} は origin=${t.origin} を申告しているが解決記録が無い（登録が解決機能の導入より前か、解決に失敗した）\n`);
}
if (!doneVerified.length) {
  process.stdout.write(
    'NG: OS自身が要求した仕事（originが台帳の実在項目に解決されたタスク）の完了実績が1件も無い。\n'
    + '装置は指示されたときだけ動いている。agendaが挙げた仕事を --origin agenda:<項目のref> で\n'
    + '登録して完了させることでしか、この記録は生まれない\n'
  );
  process.exit(1);
}
process.stdout.write('\n合格: 台帳に解決されたOS由来の仕事の完了実績が存在する\n');
