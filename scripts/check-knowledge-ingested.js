#!/usr/bin/env node
'use strict';
// F015の検出器: 宣言した知識源が、World Modelに取り込まれているか。
//
// goal.yaml が `sources[].memory_dir` / `rule_docs` を宣言していても、取り込みを回さなければ
// World Model にノードは無い。**宣言と実体の差は誰も見ていなかった。**
// 実測: memory_dir に9ファイルあるのにノードは4件で、goal監査は記録された意図の56%を
// 見ずに回っていた（その5件には、監査の直前に書かれた恒久の方針3件が含まれていた）。
//
// 「知識源が無い」ことは違反にしない（宣言しない自由がある）。違反は
// **宣言したのに取り込まれていない**ことである。
// 読めないファイルは「無い」と混同せず、別の違反として出す。
//
// 使い方: node scripts/check-knowledge-ingested.js [.osのパス]
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

let goal;
try {
  const { parseYaml } = require(path.join(__dirname, '..', 'core', 'yaml'));
  const { readTextFile } = require(path.join(__dirname, '..', 'core', 'util'));
  goal = parseYaml(readTextFile(path.join(osDir, 'goal.yaml')));
} catch (e) {
  process.stdout.write(`NG: goal.yamlを読めない: ${e.message}\n`);
  process.exit(1);
}

// 取り込み済みのref。ingest-* は provenance.ref に**絶対パス**を焼くため、
// 台帳を別のチェックアウトへ複製すると照合が丸ごと外れる（fixtureで実際に起きた）。
// 照合はパス末尾（ディレクトリ名 + ファイル名）で行い、絶対パスの一致には依存しない。
function refKey(p) {
  const parts = String(p).replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

const ingestedRefs = new Set();
for (const e of readJsonl(path.join(osDir, 'world_model', 'events.jsonl'))) {
  const p = e && e.provenance;
  if (p && typeof p.ref === 'string' && /^ingest-/.test(String(p.source || ''))) {
    ingestedRefs.add(refKey(p.ref));
  }
}

const violations = [];
let declared = 0;
let ingested = 0;

function checkFiles(scope, kind, files) {
  for (const f of files) {
    declared++;
    if (ingestedRefs.has(refKey(f))) {
      ingested++;
      continue;
    }
    violations.push(`NG: ${scope} / ${kind}: 宣言されているがWorld Modelに取り込まれていない: ${f}`);
  }
}

for (const src of goal.sources || []) {
  const scope = src.scope || '(scope未設定)';
  const repo = src.repo ? path.resolve(path.dirname(osDir), src.repo) : path.dirname(osDir);
  if (src.memory_dir) {
    const dir = path.resolve(path.dirname(osDir), src.memory_dir);
    if (!fs.existsSync(dir)) {
      violations.push(`NG: ${scope} / memory_dir: 宣言されたディレクトリが存在しない: ${dir}`);
    } else {
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
          .map((f) => path.join(dir, f));
      } catch (e) {
        violations.push(`NG: ${scope} / memory_dir: 読めない（「取り込み済み」とも「無い」とも扱わない）: ${e.message}`);
        files = [];
      }
      checkFiles(scope, 'memory_dir', files);
    }
  }
  for (const doc of src.rule_docs || []) {
    const abs = path.resolve(repo, doc);
    if (!fs.existsSync(abs)) {
      violations.push(`NG: ${scope} / rule_docs: 宣言されたファイルが存在しない: ${abs}`);
      continue;
    }
    checkFiles(scope, 'rule_docs', [abs]);
  }
}

for (const v of violations) process.stdout.write(v + '\n');
if (violations.length) {
  process.stdout.write(
    `\n違反 ${violations.length}件。宣言した知識源が取り込まれていない（F015）。`
    + 'node cli/index.js ingest all を実行するか、goal.yamlの宣言を実体に合わせること\n'
  );
  process.exit(1);
}
process.stdout.write(`ok: 宣言された知識源${declared}件はすべてWorld Modelに取り込まれている（${ingested}件）\n`);
process.exit(0);
