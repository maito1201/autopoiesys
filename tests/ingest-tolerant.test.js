'use strict';
// ingest memory の耐性（E2）。検証する要件: ①frontmatterが壊れた1件のために取込全体が
// abortしない ②壊れたファイルはパスと理由つきで warnings に上がる ③健全なファイルは
// 全件取り込まれる ④「descriptionが無い（対象外）」と「壊れている（要修正）」を区別する
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeOs, write } = require('./helpers');
const store = require('../core/store');
const { ingestMemoryIndex } = require('../core/ingest');

const memo = (name, desc, type = 'feedback') =>
  ['---', `name: ${name}`, `description: ${desc}`, 'metadata:', `  type: ${type}`, '---', '', '本文'].join('\n');

function liveByTag(osDir, tag) {
  const snap = store.getSnapshot(osDir);
  return Object.values(snap.statements).filter((s) => (s.tags || []).includes(tag));
}

test('ingest memory: frontmatterが壊れたファイルがあっても残りを取り込み、理由を警告に出す', () => {
  const { root, osDir } = makeOs();
  const dir = path.join(root, 'mem');
  write(dir, 'ok1.md', memo('ok1', 'prettier の一括整形は禁止'));
  write(dir, 'ok2.md', memo('ok2', 'issue 1 はPR 2でマージ済み', 'project'));
  // タブインデント（同梱パーサの非対応構文）
  write(dir, 'bad-tab.md', ['---', 'name: bad_tab', 'metadata:', '\ttype: feedback', '---', '', '本文'].join('\n'));
  // 閉じていない引用
  write(dir, 'bad-quote.md', ['---', "description: 'closing quote is missing", '---', '', '本文'].join('\n'));
  // frontmatterがマップではない（索引として読めない形。旧実装では黙って0件扱いになっていた）
  write(dir, 'bad-list.md', ['---', '- a', '- b', '---', '', '本文'].join('\n'));

  const r = ingestMemoryIndex(osDir, { scope: 'repo-a', dir });

  // 健全な2件は取り込まれる（1件の不正で121件が止まった実績への対処）
  assert.strictEqual(r.added.length, 2);
  const mems = liveByTag(osDir, 'memory');
  assert.strictEqual(mems.length, 2);
  assert.ok(mems.some((s) => s.body.includes('prettier')));
  assert.ok(mems.some((s) => s.body.includes('issue 1')));

  // 壊れた3件はスキップ件数として分かる
  assert.strictEqual(r.files_seen, 5);
  assert.deepStrictEqual(r.skipped_files.sort(), ['bad-list.md', 'bad-quote.md', 'bad-tab.md']);
  assert.strictEqual(r.unparsable_files.length, 3);

  // 警告にはファイルパスと理由が両方入る（どれをどう直せばよいか分かる）
  const warn = r.warnings.join('\n');
  for (const f of ['bad-tab.md', 'bad-quote.md', 'bad-list.md']) {
    assert.ok(warn.includes(path.join(dir, f)), `${f} のパスが警告に無い`);
  }
  assert.match(warn, /タブによるインデントは非対応/);
  assert.match(warn, /閉じていない引用/);
  assert.match(warn, /frontmatterがマップではない/);
  const tab = r.unparsable_files.find((u) => u.file === 'bad-tab.md');
  assert.strictEqual(tab.path, path.join(dir, 'bad-tab.md'));
  assert.match(tab.reason, /frontmatterを解析できない/);
});

test('ingest memory: 「descriptionが無い」と「壊れている」を区別する', () => {
  const { root, osDir } = makeOs();
  const dir = path.join(root, 'mem');
  write(dir, 'no-desc.md', ['---', 'name: no_desc', 'metadata:', '  type: feedback', '---', '', '本文'].join('\n'));
  write(dir, 'plain.md', '# frontmatterを持たないメモ\n\n本文');
  write(dir, 'bad.md', ['---', 'name: bad', 'metadata:', '\ttype: feedback', '---'].join('\n'));

  const r = ingestMemoryIndex(osDir, { scope: 'repo-a', dir });
  assert.deepStrictEqual(r.added, []);
  // 3件ともスキップだが、直すべきなのは壊れている1件だけ
  assert.deepStrictEqual(r.skipped_files.sort(), ['bad.md', 'no-desc.md', 'plain.md']);
  assert.deepStrictEqual(r.unparsable_files.map((u) => u.file), ['bad.md']);
  assert.strictEqual(r.warnings.length, 1);
});

test('ingest memory: 壊れたファイルがあってもdryRunは動き、健全な分だけをwould_addに出す', () => {
  const { root, osDir } = makeOs();
  const dir = path.join(root, 'mem');
  write(dir, 'ok.md', memo('ok', 'prettier の一括整形は禁止'));
  write(dir, 'bad.md', ['---', 'a: [1, 2', '---'].join('\n'));

  const dry = ingestMemoryIndex(osDir, { scope: 'repo-a', dir, dryRun: true });
  assert.strictEqual(dry.would_add.length, 1);
  assert.strictEqual(dry.unparsable_files.length, 1);
  assert.strictEqual(dry.warnings.length, 1); // dryRunでも取込漏れの理由は申告される
  assert.strictEqual(store.loadEvents(osDir).length, 0);
});

test('ingest memory: 壊れたファイルを直せば次のingestで取り込まれる（黙って落ち続けない）', () => {
  const { root, osDir } = makeOs();
  const dir = path.join(root, 'mem');
  write(dir, 'ok.md', memo('ok', 'prettier の一括整形は禁止'));
  write(dir, 'bad.md', ['---', 'name: bad', 'metadata:', '\ttype: feedback', '---'].join('\n'));
  assert.strictEqual(ingestMemoryIndex(osDir, { scope: 'repo-a', dir }).added.length, 1);

  write(dir, 'bad.md', memo('bad', 'コミットは人間が行う'));
  const after = ingestMemoryIndex(osDir, { scope: 'repo-a', dir });
  assert.strictEqual(after.added.length, 1);
  assert.deepStrictEqual(after.unparsable_files, []);
  assert.deepStrictEqual(after.warnings, []);
  assert.strictEqual(liveByTag(osDir, 'memory').length, 2);
});
