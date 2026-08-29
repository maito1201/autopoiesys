#!/usr/bin/env node
'use strict';
// F008の予防資産: golden taskのfixtureが「検証対象の検出器そのもの」を影で置き換えていないか。
//
// regressionはfixture付きcheckを cwd=fixture で走らせる。evaluatorのargvが相対パスだと、
// 実行されるのはfixture内の複製になり、その複製はfixture作成時点で凍結される。
// 本体の検出器を書き換えてもgoldenは複製に対してPASSを出し続け、
// 検出力テストが自分自身のスナップショットを検証する状態になる（実際にそうなっていた）。
//
// **fixture内のファイルには2種類あり、片方は正当である。**
//   - 検出器が読むデータ（SCHEMA.md・core/store.js 等）: 検査対象の入力。あるべきもの
//   - 検出器そのもの（evaluatorのargvが実行するスクリプト）: 影。あってはならないもの
// この検出器が見るのは後者だけである。「fixtureにファイルを置くな」ではない。
//
// 強制するのは影の不在だけで、fixtureの中身がどうあるべきかは決めない（S0018）。
//
// 使い方: node scripts/check-fixture-shadowing.js [リポジトリルート]（既定はcwd）
const fs = require('node:fs');
const path = require('node:path');
const { parseYaml } = require('../core/yaml');

const root = path.resolve(process.argv[2] || process.cwd());
const osDir = path.join(root, '.os');
const violations = [];
const oks = [];
// 検査できなかったcheck（黙って落とさず、必ず出力に出す）
const unresolved = [];

function readYaml(file) {
  try {
    return parseYaml(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    violations.push(`${path.relative(root, file)}: 読込・解析に失敗（${e.message}）`);
    return null;
  }
}

function listYaml(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
    .sort()
    .map((n) => path.join(dir, n));
}

const goldenDir = path.join(osDir, 'golden_tasks');
const evaluatorDir = path.join(osDir, 'evaluators');
if (!fs.existsSync(goldenDir)) {
  process.stdout.write(`ok: golden_tasks が無い（検査対象なし）: ${path.relative(root, goldenDir)}\n`);
  process.exit(0);
}

// evaluator id -> argv
const argvById = {};
for (const file of listYaml(evaluatorDir)) {
  const def = readYaml(file);
  if (def && def.id && Array.isArray(def.argv)) argvById[def.id] = def.argv.map((a) => String(a));
}

let checked = 0;
for (const file of listYaml(goldenDir)) {
  const def = readYaml(file);
  if (!def || !Array.isArray(def.checks)) continue;
  for (const check of def.checks) {
    if (!check || !check.fixture) continue;
    const argv = argvById[check.evaluator];
    // command方式でないevaluator（deterministic / llm_judge）は実行スクリプトを持たない
    if (!argv || argv.length < 2) continue;
    // 検査できない形（node以外の実行体・絶対パス）を**黙って飛ばさない**。
    // 静かなスキップは、この検出器が防いでいる失敗（緑のまま空振りする検査）そのものである
    if (argv[0] !== 'node' || path.isAbsolute(argv[1])) {
      unresolved.push(`${def.id} / ${check.evaluator}: argv=${JSON.stringify(argv)} は影の検査対象外`
        + '（nodeスクリプトの相対パスでないため、regressionも本体側への解決を行わない）');
      continue;
    }
    const scriptRel = argv[1];
    checked++;
    const fixtureDir = path.resolve(root, check.fixture);
    const shadow = path.resolve(fixtureDir, scriptRel);
    const real = path.resolve(root, scriptRel);
    if (fs.existsSync(shadow)) {
      violations.push(
        `${def.id} / ${check.evaluator}: fixture内に検出器の複製がある — ${path.relative(root, shadow)}`
        + `（本体は ${path.relative(root, real)}）。複製を消し、regressionに本体を実行させること`
      );
    } else {
      oks.push(`${def.id} / ${check.evaluator}: 影なし（${path.relative(root, real)} を実行する）`);
    }
  }
}

for (const o of oks) process.stdout.write(`ok: ${o}\n`);
process.stdout.write(`ok: fixture付きcommand checkを${checked}件検査（検査対象外 ${unresolved.length}件）\n`);
for (const u of unresolved) process.stdout.write(`注記: ${u}\n`);
if (violations.length) {
  process.stdout.write(`\nNG: fixtureが検出器を影で置き換えている（${violations.length}件）\n`);
  for (const v of violations) process.stdout.write(`  - ${v}\n`);
  process.stdout.write('\ngoldenがPASSし続けても、それは複製がその複製に対して期待どおり振る舞う証拠でしかない\n');
  process.exit(1);
}
process.stdout.write('\n違反なし: fixtureは検出器を影で置き換えていない\n');
