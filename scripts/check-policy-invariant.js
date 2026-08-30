#!/usr/bin/env node
'use strict';
// 方針層の不変条件を検査する（F004由来）。
//
// 検査するのは**状態の不変条件**であって、コードの書き方でも文書の文面でもない。
// 「反証されたのに発火し続けている方針が1件も無いこと」だけを見る。
// 撤回を裁量にする抜け道が実装に入り込めば、この検査が状態として捉える。
//
// 内容（どの選択が正しいか）は一切判定しない。判定するのは
// 「反証済みの方針が active のまま残っていないか」だけである。
//
// 使い方: node scripts/check-policy-invariant.js [.osのパス]
const fs = require('node:fs');
const path = require('node:path');
// 判断の場の鍵は、実装と同じ1本の規則（policy.decisionKey）で引く。
// 検出器の中で鍵の計算を書き写すと、実装側の規則が変わったときに検出器だけが
// 旧規則で照合し続け、安全網が黙って無効になる（実際にそうなった: 鍵を
// situation から引き直すように直した際、この検出器だけが生の fingerprint を見ていた）。
// 検査対象はあくまで**状態の不変条件**であって鍵の計算そのものではないため、
// 鍵の規則は実装に委ね、その規則自体は tests/decision.test.js の変異注入で守る。
const { decisionKey } = require('../core/policy');

const osDir = path.resolve(process.argv[2] || '.os');
const violations = [];
const notes = [];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// 方針ファイルから必要な3項目だけを取り出す（YAMLパーサを持ち込まない）。
// 検査に要るのは fingerprint / status / recompile だけである。
function readPolicyFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const pick = (key) => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return { file, fingerprint: pick('fingerprint'), status: pick('status'), recompile: pick('recompile') };
}

const rulesDir = path.join(osDir, 'rules');
const policies = fs.existsSync(rulesDir)
  ? fs.readdirSync(rulesDir).filter((f) => /^policy-.*\.yaml$/.test(f))
    .map((f) => readPolicyFile(path.join(rulesDir, f)))
  : [];

const events = readJsonl(path.join(osDir, 'world_model', 'events.jsonl'));
// 現在状態: supersedes されたStatementは除く
const superseded = new Set(events.map((e) => e.supersedes).filter(Boolean));
const current = events.filter((e) => e.id && !superseded.has(e.id));
const decisions = {};
for (const e of current) if (e.type === 'decision') decisions[e.id] = e;

// 判断の場ごとに「unmet が記録されたか」「方針に反する選択が met になったか」を畳む
const unmetFps = new Set();
const contradictedFps = new Set();
const policyByFp = {};
for (const p of policies) if (p.fingerprint) policyByFp[p.fingerprint] = p;

for (const e of current) {
  if (e.type !== 'outcome') continue;
  const target = e.decision || (e.links || []).find((l) => l.role === 'derived_from')?.to;
  const d = target && decisions[target];
  if (!d) continue;
  const key = decisionKey(d);
  if (!key) continue;
  if (e.result === 'unmet') unmetFps.add(key);
  if (e.result === 'met') {
    const p = policyByFp[key];
    // 方針に反する選択が met になった場は凍結されていなければならない（DESIGN 3層目）。
    // 「どちらの選択も met になる」なら、場を分ける条件が situation に書かれていない
    if (p && p.status === 'active' && d.chosen && p.choose && p.choose !== d.chosen) {
      contradictedFps.add(key);
    }
  }
}

for (const p of policies) {
  if (p.status !== 'active') continue;
  if (!p.fingerprint) {
    violations.push(`${path.basename(p.file)}: fingerprint が読めない（照合不能な方針は発火させてはならない）`);
    continue;
  }
  if (unmetFps.has(p.fingerprint)) {
    violations.push(
      `${path.basename(p.file)}: この判断の場には unmet の結果が記録されているのに status: active のまま。` +
      '反証された方針が発火し続けている（撤回は裁量ではなく自動でなければならない）'
    );
  }
  if (contradictedFps.has(p.fingerprint)) {
    violations.push(
      `${path.basename(p.file)}: この判断の場では方針と異なる選択も met になっているのに status: active のまま。` +
      'どちらの選択も met になる場は凍結されなければならない（場を分ける条件が situation に無い）'
    );
  }
}

// 撤回済みなのに再コンパイルされて active に戻っている、という抜け道も塞ぐ
for (const p of policies) {
  if (p.status === 'active' && p.recompile === 'blocked') {
    violations.push(`${path.basename(p.file)}: 凍結（recompile: blocked）された判断の場が active に戻っている`);
  }
}

notes.push(`方針ファイル: ${policies.length}件（active ${policies.filter((p) => p.status === 'active').length}件）`);
notes.push(`unmet が記録された判断の場: ${unmetFps.size}件`);
notes.push(`検査した現在Statement: ${current.length}件`);

for (const n of notes) process.stdout.write(`ok: ${n}\n`);
if (violations.length) {
  for (const v of violations) process.stdout.write(`NG: ${v}\n`);
  process.stdout.write(`\n違反 ${violations.length}件\n`);
  process.exit(1);
}
process.stdout.write('\n違反なし: 反証された方針は1件も発火していない\n');
