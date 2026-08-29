#!/usr/bin/env node
'use strict';
// sc-003（ドキュメントと実装が矛盾しない）の部分接地検出器。
// 「文書と実装のドリフト」のうち**列挙可能なもの**だけを機械検査する:
//   1. core/store.js STATEMENT_TYPES  ↔ SCHEMA.md Statement節の type 一覧
//   2. core/store.js LINK_ROLES       ↔ SCHEMA.md Statement節の links[].role 一覧
//   3. core/evaluate.js REASONS       ↔ SCHEMA.md verdict節の reason 一覧
//   4. core/failure.js STATES / CLASSIFICATIONS ↔ SCHEMA.md Failure節の状態機械の表
//   5. docs/USAGE.md・SCHEMA.md の `node cli/index.js <cmd>` ↔ cli/index.js COMMANDS
//   6. core/gap.js CLASSIFICATIONS ↔ SCHEMA.md Intelligence Gap Analysis節の分類表
// 全文の意味的整合は対象外 — 過大な検出器は誤検出し、誤検出する検出器は
// 無いのと同じか、それ以下である（check-skill-commands.js と同じ設計判断）。
//
// 実装側の定数は require せず正規表現でソースから抽出する。cli/index.js は
// 末尾で main() を無条件実行するため、require した瞬間にCLIとして走ってしまう。
// core側は現状 require 可能だが、検出器が実装の副作用に依存しない一貫した方式を選ぶ。
//
// 文書側の一覧は「その節の中」だけから抽出する。文書全体に網を張ると、
// 散文や例文の中の同名語を拾って誤検出する。逆に、節見出しや一覧の書式が
// 変わって抽出できなくなった場合は沈黙せず NG にする — 抽出不能を「違反ゼロ」と
// 報告する検出器は、ドリフトの検査そのものが静かに死ぬ。
//
// 使い方: node scripts/check-docs-drift.js [リポジトリルート]（既定はcwd）
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || process.cwd());
const violations = [];
const oks = [];

function ng(msg) {
  violations.push(msg);
}

function readFile(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    ng(`${rel}: ファイルが存在しない（検査対象の実在が前提）`);
    return null;
  }
  // BOMは除去して読む（PowerShell経由で保存されたファイルへの偽NG防止）
  return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// 実装側: `const NAME = [ ... ];` の文字列要素を抽出する（//コメントは除去）
function extractStringArray(src, name, rel) {
  const m = new RegExp(`const ${name} = \\[`).exec(src);
  if (!m) {
    ng(`${rel}: const ${name} = [...] が見つからない（実装側の抽出不能。定数名の変更ならこの検出器も追随させること）`);
    return null;
  }
  const start = m.index + m[0].length;
  const end = src.indexOf('];', start);
  if (end < 0) {
    ng(`${rel}: ${name} の閉じ ]; が見つからない`);
    return null;
  }
  const body = src.slice(start, end).replace(/\/\/[^\n]*/g, '');
  const values = [...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map((s) => s[1] ?? s[2]);
  if (!values.length) {
    ng(`${rel}: ${name} から要素を抽出できない`);
    return null;
  }
  return { rel, values, line: lineOf(src, m.index) };
}

// 文書側: 見出しプレフィックス（例 "## Statement"）から次の "## " までの行範囲
function sectionOf(md, headingPrefix, rel) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) {
    ng(`${rel}: 節 "${headingPrefix}" が見つからない（文書側の抽出不能。見出しの変更ならこの検出器も追随させること）`);
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return { rel, lines: lines.slice(start, end), offset: start };
}

// 節内で markerRe に一致する行から始まる「a | b | c」形式の列挙を取り出す。
// 継続行（空行・新箇条書き・表・見出しの手前まで）を連結し、最初の「—」以降は
// 散文として捨てる（SCHEMA.mdのreason一覧は列挙の直後に説明散文が続く書式）。
function docEnum(sec, markerRe, label) {
  for (let i = 0; i < sec.lines.length; i++) {
    const m = markerRe.exec(sec.lines[i]);
    if (!m) continue;
    let text = sec.lines[i].slice(m.index + m[0].length);
    for (let j = i + 1; j < sec.lines.length; j++) {
      const l = sec.lines[j];
      if (!l.trim() || /^\s*- /.test(l) || l.startsWith('|') || l.startsWith('#')) break;
      text += ' ' + l.trim();
    }
    const cut = text.split('—')[0];
    const values = cut.split('|').map((s) => s.trim()).filter((s) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s));
    if (!values.length) {
      ng(`${sec.rel}:${sec.offset + i + 1}: ${label} の列挙を抽出できない（書式が変わったならこの検出器も追随させること）`);
      return null;
    }
    return { rel: sec.rel, values, line: sec.offset + i + 1 };
  }
  ng(`${sec.rel}: ${label} の列挙行が節内に見つからない（文書側の抽出不能）`);
  return null;
}

// 集合として双方向に照合する（順序は検査しない — 順序差をNGにすると誤検出側に倒れる）
function compareSets(label, impl, doc) {
  if (!impl || !doc) return; // 抽出不能は既にNG起票済み
  const implSet = new Set(impl.values);
  const docSet = new Set(doc.values);
  let bad = false;
  for (const v of impl.values) {
    if (!docSet.has(v)) {
      bad = true;
      ng(`${doc.rel}:${doc.line}: ${label}一覧に無い語（実装 ${impl.rel}:${impl.line} にはある）: ${v}`);
    }
  }
  for (const v of doc.values) {
    if (!implSet.has(v)) {
      bad = true;
      ng(`${impl.rel}:${impl.line}: 実装に無い語（文書 ${doc.rel}:${doc.line} の${label}一覧にはある）: ${v}`);
    }
  }
  if (!bad) oks.push(`ok: ${label} — 実装${implSet.size}語 = 文書${docSet.size}語`);
}

// ---- 1,2: STATEMENT_TYPES / LINK_ROLES ↔ SCHEMA.md Statement節 ----
const storeSrc = readFile('core/store.js');
const schemaMd = readFile('SCHEMA.md');
if (storeSrc && schemaMd) {
  const stmtSec = sectionOf(schemaMd, '## Statement', 'SCHEMA.md');
  if (stmtSec) {
    compareSets('type', extractStringArray(storeSrc, 'STATEMENT_TYPES', 'core/store.js'),
      docEnum(stmtSec, /^- `type`:\s*/, 'type'));
    compareSets('links[].role', extractStringArray(storeSrc, 'LINK_ROLES', 'core/store.js'),
      docEnum(stmtSec, /^- `links\[\]\.role`:\s*/, 'links[].role'));
  }
}

// ---- 6: gap CLASSIFICATIONS ↔ SCHEMA.md Intelligence Gap Analysis節の分類表 ----
// F010の予防: 分類語彙から1語（UNMET = 測ったが不合格）が落ちると、
// 目的層の未達が可用（AVAILABLE）に吸い込まれて見えなくなる。
// 語彙が実装と文書で食い違うことは決定的に検出できる。
const gapSrc = readFile('core/gap.js');
if (gapSrc && schemaMd) {
  const gapSec = sectionOf(schemaMd, '## Intelligence Gap Analysis', 'SCHEMA.md');
  if (gapSec) {
    // 表の第2列 = 分類名。区切り行とヘッダ行は読み飛ばす
    const names = [];
    let tableLine = -1;
    for (let i = 0; i < gapSec.lines.length; i++) {
      const l = gapSec.lines[i];
      if (!l.startsWith('|')) continue;
      const cells = l.split('|').map((c) => c.trim());
      const name = cells[2] || '';
      if (name === '分類') { tableLine = gapSec.offset + i + 1; continue; }
      if (/^[-: ]*$/.test(cells[1] || '')) continue;
      if (/^[A-Z][A-Z_]+$/.test(name)) names.push(name);
    }
    if (!names.length) {
      ng('SCHEMA.md: Intelligence Gap Analysis節の分類表から分類名を抽出できない（書式が変わったならこの検出器も追随させること）');
    } else {
      compareSets('gap classification',
        extractStringArray(gapSrc, 'CLASSIFICATIONS', 'core/gap.js'),
        { rel: 'SCHEMA.md', values: names, line: tableLine });
    }
  }
}

// ---- 3: REASONS ↔ SCHEMA.md verdict節 ----
const evalSrc = readFile('core/evaluate.js');
if (evalSrc && schemaMd) {
  const verdictSec = sectionOf(schemaMd, '## verdict', 'SCHEMA.md');
  if (verdictSec) {
    compareSets('reason', extractStringArray(evalSrc, 'REASONS', 'core/evaluate.js'),
      docEnum(verdictSec, /^`reason`[^:]*:\s*/, 'reason'));
  }
}

// ---- 4: STATES / CLASSIFICATIONS ↔ SCHEMA.md Failure節の状態機械の表 ----
const failSrc = readFile('core/failure.js');
if (failSrc && schemaMd) {
  const failSec = sectionOf(schemaMd, '## Failure', 'SCHEMA.md');
  if (failSec) {
    // 表の第1列 = 遷移先の状態。「a → a」の自己遷移行は矢印で割って両辺を状態として読む
    const states = [];
    let headerLine = -1;
    let classifiedRow = null;
    for (let i = 0; i < failSec.lines.length; i++) {
      const l = failSec.lines[i];
      if (!l.startsWith('|')) continue;
      const cells = l.split('|').map((c) => c.trim());
      const first = cells[1] || '';
      if (first === '遷移先') {
        headerLine = failSec.offset + i + 1;
        continue;
      }
      if (/^[-: ]*$/.test(first)) continue; // 区切り行
      for (const part of first.split('→').map((s) => s.trim())) {
        if (/^[a-z][a-z0-9_]*$/.test(part) && !states.includes(part)) states.push(part);
      }
      if (first.split('→')[0].trim() === 'classified') {
        classifiedRow = { line: failSec.offset + i + 1, text: l };
      }
    }
    if (headerLine < 0 || !states.length) {
      ng('SCHEMA.md: Failure節に状態機械の表（第1列「遷移先」）が見つからない（文書側の抽出不能）');
    } else {
      compareSets('状態機械 state', extractStringArray(failSrc, 'STATES', 'core/failure.js'),
        { rel: 'SCHEMA.md', values: states, line: headerLine });
      if (!classifiedRow) {
        ng('SCHEMA.md: 状態機械の表に classified 行が無く、classification一覧を照合できない');
      } else {
        // classified行の {…} ∪ {…} の中身が分類の全語彙
        const classifications = [];
        for (const m of classifiedRow.text.matchAll(/\{([^}]*)\}/g)) {
          for (const t of m[1].split(',').map((s) => s.trim())) {
            if (/^[a-z][a-z0-9_]*$/.test(t)) classifications.push(t);
          }
        }
        if (!classifications.length) {
          ng(`SCHEMA.md:${classifiedRow.line}: classified行から classification の語彙を抽出できない`);
        } else {
          compareSets('classification', extractStringArray(failSrc, 'CLASSIFICATIONS', 'core/failure.js'),
            { rel: 'SCHEMA.md', values: classifications, line: classifiedRow.line });
        }
      }
    }
  }
}

// ---- 5: 文書中の `node cli/index.js <cmd>` の第1語 ↔ cli/index.js COMMANDS ----
const cliSrc = readFile('cli/index.js');
if (cliSrc) {
  let commands = null;
  const m = /const COMMANDS = \{/.exec(cliSrc);
  const end = m ? cliSrc.indexOf('\n};', m.index) : -1;
  if (!m || end < 0) {
    ng('cli/index.js: const COMMANDS = {...} が見つからない（実装側の抽出不能）');
  } else {
    // オブジェクトリテラル直下（インデント2）のメソッド定義だけをキーとして読む。
    // ボディ内の if(...) 等はインデントが深いので拾わないが、念のため予約語は除外する
    const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);
    commands = new Set();
    for (const k of cliSrc.slice(m.index, end).matchAll(/^  (?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*\(/gm)) {
      const name = k[1] ?? k[2] ?? k[3];
      if (!keywords.has(name)) commands.add(name);
    }
    if (!commands.size) {
      ng('cli/index.js: COMMANDS からコマンド名を抽出できない');
      commands = null;
    }
  }
  if (commands) {
    let checked = 0;
    let cmdBad = false;
    for (const rel of ['docs/USAGE.md', 'SCHEMA.md']) {
      const md = rel === 'SCHEMA.md' ? schemaMd : readFile(rel);
      if (md === null) continue;
      const lines = md.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // パス接頭辞つき（node autopoiesys/cli/index.js init 等）も対象にする
        for (const c of lines[i].matchAll(/\bnode\s+(?:[\w.-]+[\\/])*cli\/index\.js\s+(\S+)/g)) {
          const token = c[1].replace(/[`"'）)。、,]+$/, '');
          // フラグ（-x）とプレースホルダ（<cmd>）は第1語のコマンドではないので対象外
          if (token.startsWith('-') || token.startsWith('<')) continue;
          if (!/^[A-Za-z][\w-]*$/.test(token)) continue;
          checked++;
          if (!commands.has(token)) {
            cmdBad = true;
            ng(`${rel}:${i + 1}: cli/index.js のCOMMANDSに存在しないコマンド: ${token} — ${lines[i].trim()}`);
          }
        }
      }
    }
    if (!cmdBad) oks.push(`ok: node cli/index.js <cmd> — 文書中の${checked}箇所すべてがCOMMANDS（${commands.size}個）に実在`);
  }
}

for (const o of oks) process.stdout.write(o + '\n');
if (violations.length) {
  for (const v of violations) process.stdout.write(`NG: ${v}\n`);
  process.stdout.write(`\n違反 ${violations.length}件。文書と実装のどちらが正かは検出器は判断しない — 両方の該当行を見て一致させること\n`);
  process.exit(1);
}
process.stdout.write('違反なし: 列挙可能な範囲で文書と実装は一致している\n');
