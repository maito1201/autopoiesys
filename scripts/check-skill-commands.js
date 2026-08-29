#!/usr/bin/env node
'use strict';
// c-003の検出器: Skillが発行するコマンドにシェル構文（パイプ・リダイレクト・連結）が
// 無いことを検査する。この制約の理由は移植性 — コマンドは PowerShell / cmd / sh の
// どれで実行されるか分からないため、`node cli/index.js <cmd>` の1形式だけを許す。
//
// 検査対象は SKILL.md 内の「cli/index.js を含む行」だけに絞る。
// 文書全体に網を張ると、Markdownの表の `|` や説明文の `>` を誤検出する
// （誤検出する検出器は無視されるだけで、無いのと同じか、それ以下である）。
//
// 使い方: node scripts/check-skill-commands.js [skillsディレクトリ]
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || 'skills');
const violations = [];
let checked = 0;

// プレースホルダ <low|medium|high> と引用文字列 "..." の中身はコマンド構文ではない。
// 先に潰してから、残った文字列にシェル記号があるかを見る
function stripNonSyntax(line) {
  return line
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/<[^>]*>/g, '<>');
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'SKILL.md') checkFile(p);
  }
}

function checkFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('cli/index.js')) continue;
    checked++;
    const s = stripNonSyntax(lines[i]);
    const found = [];
    if (/\|\|/.test(s)) found.push('||');
    else if (/\|/.test(s)) found.push('|');
    if (/&&/.test(s)) found.push('&&');
    if (/;/.test(s)) found.push(';');
    // リダイレクト。プレースホルダ除去後の裸の > と < を見る（<> はプレースホルダの痕跡）
    if (/(^|[^<])>(?!>)/.test(s.replace(/<>/g, '')) || />>/.test(s)) found.push('>');
    if (found.length) {
      violations.push(`${path.relative(process.cwd(), file)}:${i + 1}: シェル構文 ${found.join(' ')} — ${lines[i].trim()}`);
    }
  }
}

walk(root);
process.stdout.write(`ok: cli/index.js を含む行を${checked}行検査した\n`);
if (violations.length) {
  for (const v of violations) process.stdout.write(`NG: ${v}\n`);
  process.stdout.write(`\n違反 ${violations.length}件。コマンドは node cli/index.js <cmd> の1形式のみ（パイプ・リダイレクト・連結は移植性を壊す）\n`);
  process.exit(1);
}
process.stdout.write('違反なし: Skillのコマンドにシェル構文は無い\n');
