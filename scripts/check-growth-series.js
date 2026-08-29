#!/usr/bin/env node
'use strict';
// sc-004の検出器: 開発タスクが類型付きで回り、成長の系列（同一類型3試行以上）が
// 記録されていることを検査する。
//
// これは「成長している」ことの検査ではない — 成長の有無を機械が断定すると
// 測定が主張になる。検査するのは**測定が存在すること**だけである。
// 系列が空なら、日々の仕事が類型なしで流れており、経験の再利用が働いていない。
//
// 使い方: node scripts/check-growth-series.js [.osのパス]
const path = require('node:path');
const growth = require('../core/growth');

const osDir = path.resolve(process.argv[2] || '.os');
const series = growth.growthSeries(osDir);
const classes = Object.keys(series);
const mature = classes.filter((fp) => series[fp].attempts.length >= growth.MIN_ATTEMPTS_FOR_TREND);

process.stdout.write(`ok: 類型${classes.length}件、うち${growth.MIN_ATTEMPTS_FOR_TREND}試行以上は${mature.length}件\n`);
for (const fp of mature) {
  process.stdout.write(`ok: ${series[fp].class}（${series[fp].attempts.length}試行）\n`);
}
if (!mature.length) {
  process.stdout.write(
    `NG: ${growth.MIN_ATTEMPTS_FOR_TREND}試行以上の類型が1件も無い。` +
    'タスクを --class 付きで登録していないか、同種の仕事に毎回違う類型を付けている\n'
  );
  process.exit(1);
}
process.stdout.write('違反なし: 成長の系列が記録されている\n');
