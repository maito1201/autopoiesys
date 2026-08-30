#!/usr/bin/env node
'use strict';
// F013の検出器: 取り下げが「やった仕事を消す」経路になっていないか。
//
// 誤登録したタスクを取り下げる経路は必要である（残すと警告が恒久点灯し、成長の系列に
// 「試行」として並んで自己測定を汚す）。だが取り下げを何にでも使えると、
// **失敗を台帳から消す道具**になる。
//
// したがって取り下げてよいのは「何も行われていないタスク」だけである:
//   - 成果物が1件でもある → 仕事はされている
//   - verdictが1件でもある → 判定は行われている
//   - 理由が無い → 開示が無い（取り下げの記録が意味を持たない）
// コマンド側でも同じ規律を強制しているが、台帳を直接編集しても迂回できないよう、
// 状態として検査する。
//
// 使い方: node scripts/check-withdrawn-tasks.js [.osのパス]
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

const byId = {};
for (const r of readJsonl(path.join(osDir, 'tasks', 'tasks.jsonl'))) {
  if (r && r.id) byId[r.id] = { ...(byId[r.id] || {}), ...r };
}
const verdictCount = {};
for (const v of readJsonl(path.join(osDir, 'evaluations', 'log.jsonl'))) {
  if (v && v.task) verdictCount[v.task] = (verdictCount[v.task] || 0) + 1;
}

const violations = [];
let withdrawn = 0;
for (const t of Object.values(byId)) {
  if (t.status !== 'withdrawn') continue;
  withdrawn++;
  const artifacts = (t.artifacts || []).length;
  const verdicts = verdictCount[t.id] || 0;
  if (artifacts || verdicts) {
    violations.push(
      `NG: ${t.id}: 取り下げられているが仕事の記録がある（成果物${artifacts}件・verdict${verdicts}件）。`
      + '取り下げは誤登録のためのもので、行われた仕事を台帳から消す経路ではない'
    );
  }
  if (!t.withdrawn_reason || !String(t.withdrawn_reason).trim()) {
    violations.push(`NG: ${t.id}: 取り下げの理由が記録されていない（開示のない取り下げは記録にならない）`);
  }
}

for (const v of violations) process.stdout.write(v + '\n');
if (violations.length) {
  process.stdout.write(`\n違反 ${violations.length}件。取り下げが仕事の隠蔽に使われている（F013）\n`);
  process.exit(1);
}
process.stdout.write(`ok: 取り下げられたタスク${withdrawn}件はいずれも成果物・verdictを持たず、理由が記録されている\n`);
process.exit(0);
