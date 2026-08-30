#!/usr/bin/env node
'use strict';
// F014の検出器: 判定器の弱体化が、理由の開示なく起きていないか。
//
// 完了認定は「宣言されたevaluatorが全てPASS」で定義される。だから**宣言集合が弱ければ、
// 完全な合格と目的未達が両立する**。実測（F014）: 目的適合を見る唯一の層
// objective_alignment が同一類型の登録から落ち、5タスク連続で外れたまま完了した。
// そのあいだ評価器の件数は 9→7→8→9→9 で、新しい検出器の増設に隠れていた。
// **量ではなく集合を、同じ類型どうしで比べる。**
//
// 違反とするのは「落ちていること」ではなく「落ちたことが台帳のどこにも開示されていない」ことである
// （何を判定させるべきかはコアが決めない。決めれば内容を機械に焼き付けることになる）。
// 開示は task の notes に評価器名を含めて残す。
//
// 使い方: node scripts/check-evaluator-drift.js [.osのパス]
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

const rows = readJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'));
const createdTs = {};
const byId = {};
for (const r of rows) {
  if (!r || !r.id) continue;
  if (createdTs[r.id] === undefined) createdTs[r.id] = r.ts;
  byId[r.id] = { ...(byId[r.id] || {}), ...r };
}
const tasks = Object.values(byId)
  .filter((t) => t.class_fp)
  .map((t) => ({ ...t, created_ts: createdTs[t.id] || t.ts }))
  .sort((a, b) => (a.created_ts < b.created_ts ? -1 : a.created_ts > b.created_ts ? 1 : (a.id < b.id ? -1 : 1)));

// 類型ごとに、それまでに宣言された評価器の累積集合と比べる
const seenByClass = {};
const violations = [];
let checked = 0;
for (const t of tasks) {
  const seen = (seenByClass[t.class_fp] = seenByClass[t.class_fp] || {});
  const declared = new Set(t.evaluators || []);
  const dropped = Object.keys(seen).filter((e) => !declared.has(e)).sort();
  if (dropped.length) {
    checked++;
    const notes = (t.notes || []).map((n) => String(n.note || '')).join('\n');
    const undisclosed = dropped.filter((e) => !notes.includes(e));
    if (undisclosed.length) {
      violations.push(
        `NG: ${t.id}（類型 ${t.class_fp}）: 過去に判定させていた評価器が宣言から落ち、理由の開示が無い: `
        + undisclosed.map((e) => `${e}（過去: ${seen[e].join(', ')}）`).join(' / ')
      );
    }
  }
  for (const e of declared) (seen[e] = seen[e] || []).push(t.id);
}

for (const v of violations) process.stdout.write(v + '\n');
if (violations.length) {
  process.stdout.write(
    `\n違反 ${violations.length}件。判定器の弱体化が黙って起きている（F014）。`
    + '意図して外したなら task note に評価器名と理由を残すこと\n'
  );
  process.exit(1);
}
process.stdout.write(
  `ok: 類型つきタスク${tasks.length}件。判定器が落ちた${checked}件はいずれも理由が開示されている\n`
);
process.exit(0);
