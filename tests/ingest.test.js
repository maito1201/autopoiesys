'use strict';
// 多リポジトリ横断の取込（scope）の要件テスト。
// 検証する要件: ①別リポジトリの観測が互いを打ち消さない ②作業規約・自動メモリを
// 決定的に索引化できる ③再取込が冪等で、内容変更時だけsupersedeする
// ④既存Statementへのscope後埋めが tags∩scopes の写しに限定される
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const { ingestRepo, ingestRuleDocs, ingestMemoryIndex } = require('../core/ingest');
const { runQuery } = require('../core/query');

function repoWith(root, name, files) {
  const dir = path.join(root, name);
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  return dir;
}

function liveByTag(osDir, tag) {
  const snap = store.getSnapshot(osDir);
  return Object.values(snap.statements).filter((s) => (s.tags || []).includes(tag));
}

test('多リポジトリ: 別scopeの同種観測は互いを打ち消さない', () => {
  const { root, osDir } = makeOs();
  const a = repoWith(root, 'repo-a', { 'a.txt': 'A' });
  const b = repoWith(root, 'repo-b', { 'b.txt': 'B' });
  ingestRepo(osDir, a, { scope: 'repo-a' });
  ingestRepo(osDir, b, { scope: 'repo-b' });
  const layouts = liveByTag(osDir, 'layout');
  // 両リポジトリのlayout観測が現在状態に併存する（scope未対応時はBだけが残っていた）
  assert.strictEqual(layouts.length, 2);
  assert.deepStrictEqual(layouts.map((s) => s.scope).sort(), [['repo-a'], ['repo-b']]);
});

test('多リポジトリ: 同一scopeの再取込は冪等、内容変化時のみsupersede', () => {
  const { root, osDir } = makeOs();
  const a = repoWith(root, 'repo-a', { 'a.txt': 'A' });
  ingestRepo(osDir, a, { scope: 'repo-a' });
  const again = ingestRepo(osDir, a, { scope: 'repo-a' });
  assert.deepStrictEqual(again.added, []);
  write(a, 'c.txt', 'C');
  ingestRepo(osDir, a, { scope: 'repo-a' });
  const layouts = liveByTag(osDir, 'layout');
  assert.strictEqual(layouts.length, 1); // 旧観測はsupersedeされ矛盾が併存しない
  assert.match(layouts[0].body, /c\.txt/);
});

test('ingest rules: 見出し単位でplaybook化し、長い節は全文パスをポインタで残す', () => {
  const { root, osDir } = makeOs();
  const long = 'x'.repeat(300);
  const repo = repoWith(root, 'repo-a', {
    'CLAUDE.md': [
      '# タイトル', '前文', '', '## 禁止事項', 'go build は禁止', '', '## 章だけ', '', '### 長い節', long, '',
    ].join('\n'),
  });
  const r = ingestRuleDocs(osDir, { scope: 'repo-a', repoRoot: repo, docs: ['CLAUDE.md'], maxSectionChars: 100 });
  const rules = liveByTag(osDir, 'playbook');
  // 本文を持たない見出し（「章だけ」）はStatementにしない
  assert.strictEqual(rules.length, 3);
  assert.ok(rules.every((s) => s.type === 'constraint' && s.status === 'fact'));
  assert.ok(rules.every((s) => s.scope[0] === 'repo-a'));
  const ban = rules.find((s) => s.body.includes('go build'));
  assert.match(ban.body, /CLAUDE\.md「禁止事項」/);
  const truncated = rules.find((s) => s.body.includes('…'));
  assert.match(truncated.body, /全文: .*CLAUDE\.md の「長い節」節/);
  assert.deepStrictEqual(r.missing_docs, []);
  // 再取込は冪等、節の内容が変わったらsupersede
  assert.deepStrictEqual(ingestRuleDocs(osDir, { scope: 'repo-a', repoRoot: repo, docs: ['CLAUDE.md'], maxSectionChars: 100 }).added, []);
  write(repo, 'CLAUDE.md', ['# タイトル', '前文', '', '## 禁止事項', 'go vet も禁止', ''].join('\n'));
  ingestRuleDocs(osDir, { scope: 'repo-a', repoRoot: repo, docs: ['CLAUDE.md'], maxSectionChars: 100 });
  const after = liveByTag(osDir, 'playbook').filter((s) => s.body.includes('禁止事項'));
  assert.strictEqual(after.length, 1);
  assert.match(after[0].body, /go vet/);
});

test('ingest rules: 存在しないdocはmissingとして申告する（黙って0件にしない）', () => {
  const { root, osDir } = makeOs();
  const repo = repoWith(root, 'repo-a', { 'README.md': '#' });
  const r = ingestRuleDocs(osDir, { scope: 'repo-a', repoRoot: repo, docs: ['CLAUDE.md'] });
  assert.deepStrictEqual(r.missing_docs, ['CLAUDE.md']);
  assert.deepStrictEqual(r.added, []);
});

test('ingest memory: descriptionを索引化し、typeで status/type/tags を決める', () => {
  const { root, osDir } = makeOs();
  const dir = path.join(root, 'mem');
  write(dir, 'MEMORY.md', '- 索引本体は取込対象外');
  write(dir, 'f.md', ['---', 'name: f_rule', 'description: make fmt は禁止', 'metadata:', '  type: feedback', '---', '', '本文'].join('\n'));
  write(dir, 'p.md', ['---', 'name: p_log', 'description: issue 1 はPR 2でマージ済み', 'metadata:', '  type: project', '---', '', '本文'].join('\n'));
  write(dir, 'n.md', ['---', 'name: no_desc', 'metadata:', '  type: feedback', '---', '', '本文'].join('\n'));
  const r = ingestMemoryIndex(osDir, { scope: 'repo-a', dir });
  assert.strictEqual(r.files_seen, 3); // MEMORY.md は除外
  assert.deepStrictEqual(r.skipped_files, ['n.md']); // descriptionが無いものは取込対象外として申告
  const mems = liveByTag(osDir, 'memory');
  assert.strictEqual(mems.length, 2);
  const fb = mems.find((s) => s.body.includes('make fmt'));
  assert.strictEqual(fb.type, 'constraint');
  assert.strictEqual(fb.status, 'fact');
  assert.deepStrictEqual(fb.tags, ['playbook', 'memory', 'feedback']);
  assert.match(fb.body, /（詳細: .*f\.md）/); // 本文はパスのポインタとして残す
  const pj = mems.find((s) => s.body.includes('issue 1'));
  assert.strictEqual(pj.type, 'claim');
  assert.strictEqual(pj.status, 'hypothesis');
  assert.strictEqual(pj.confidence, 0.5);
  assert.ok(!pj.tags.includes('playbook')); // 進行中の結論は作法ではない
  // 冪等 / descriptionが変わったらsupersede
  assert.deepStrictEqual(ingestMemoryIndex(osDir, { scope: 'repo-a', dir }).added, []);
  write(dir, 'f.md', ['---', 'name: f_rule', 'description: make fmt は禁止（gofmtを使う）', 'metadata:', '  type: feedback', '---'].join('\n'));
  ingestMemoryIndex(osDir, { scope: 'repo-a', dir });
  const fbs = liveByTag(osDir, 'memory').filter((s) => s.body.includes('make fmt'));
  assert.strictEqual(fbs.length, 1);
  assert.match(fbs[0].body, /gofmt/);
});

test('ingest memory: 同じメモリ名でもscopeが違えば別Statementとして併存する', () => {
  const { root, osDir } = makeOs();
  const d1 = path.join(root, 'm1');
  const d2 = path.join(root, 'm2');
  const front = (desc) => ['---', 'name: same_name', `description: ${desc}`, 'metadata:', '  type: feedback', '---'].join('\n');
  write(d1, 'x.md', front('Aの規約'));
  write(d2, 'x.md', front('Bの規約'));
  ingestMemoryIndex(osDir, { scope: 'repo-a', dir: d1 });
  ingestMemoryIndex(osDir, { scope: 'repo-b', dir: d2 });
  assert.strictEqual(liveByTag(osDir, 'memory').length, 2);
});

test('scope絞りとtag絞りはANDで組める / 複数scopeの横断知識は双方から引ける', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'constraint', 'apiの作法', { tags: ['playbook'], scope: ['api'] }),
    statement('S0002', 'constraint', 'apiの予約ルール', { tags: ['booking'], scope: ['api'] }),
    statement('S0003', 'constraint', 'appの作法', { tags: ['playbook'], scope: ['app'] }),
    statement('S0004', 'claim', 'api↔appの契約', { tags: ['api-compat'], scope: ['api', 'app'] }),
    statement('S0005', 'constraint', '製品仕様（宛先に依らない）', { tags: ['booking'] }),
  ]);
  write(osDir, 'queries/q.yaml', [
    'name: q',
    'description: scope AND tag',
    'params:',
    '  scope: { required: false }',
    '  tag: { required: false }',
    'pipeline:',
    '  - where_param: { field: tags, contains: tag }',
    '  - where_param: { field: scope, contains: scope }',
    '  - project: [id, body, scope]',
    '  - limit: 20',
    'max_tokens: 2000',
    '',
  ].join('\n'));
  const both = runQuery(osDir, 'q', { scope: 'api', tag: 'playbook' });
  assert.deepStrictEqual(both.results.map((r) => r.id), ['S0001']);
  // 複数scopeの横断Statementはどちらのscopeで引いても返る
  assert.ok(runQuery(osDir, 'q', { scope: 'app' }).results.some((r) => r.id === 'S0004'));
  assert.ok(runQuery(osDir, 'q', { scope: 'api' }).results.some((r) => r.id === 'S0004'));
  // scope未設定の横断共通知識はscope絞りには乗らず、話題tagで引ける
  assert.ok(!runQuery(osDir, 'q', { scope: 'api' }).results.some((r) => r.id === 'S0005'));
  assert.ok(runQuery(osDir, 'q', { tag: 'booking' }).results.some((r) => r.id === 'S0005'));
});

test('scope検証: 配列以外はエラー、未登録scopeは警告', () => {
  const { osDir } = makeOs();
  assert.throws(
    () => store.assertStatements(osDir, [statement('S0001', 'claim', 'x', { scope: 'api' })]),
    /scopeは文字列の配列/
  );
  write(osDir, 'world_model/vocabulary.yaml', 'predicates: []\ntags: []\nscopes:\n  - api\n');
  const ok = store.assertStatements(osDir, [statement('S0001', 'claim', 'x', { scope: ['api'] })]);
  assert.deepStrictEqual(ok.warnings, []);
  const warned = store.assertStatements(osDir, [statement('S0002', 'claim', 'y', { scope: ['typo-api'] })]);
  assert.match(warned.warnings.join('\n'), /初出のscope: typo-api/);
});

test('backfillScope: tags∩scopesだけを写し、写せないものは横断共通のまま残す', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'claim', 'apiの事実', { tags: ['api', 'booking'] }),
    statement('S0002', 'claim', '製品仕様', { tags: ['booking'] }),
    statement('S0003', 'claim', '横断契約', { tags: ['api', 'app'] }),
    statement('S0004', 'observation', '構成観測', { tags: ['repo', 'layout'], provenance: { source: 'ingest-repo', method: 'deterministic' } }),
  ]);
  const dry = store.backfillScope(osDir, { scopes: ['api', 'app'], fallbackScope: 'os', apply: false });
  assert.strictEqual(dry.applied, false);
  assert.strictEqual(dry.scoped, 3);
  assert.strictEqual(dry.left_without_scope, 1);
  // dry-runでは1件も書き換わっていない
  assert.ok(store.loadEvents(osDir).every((e) => e.scope === undefined));

  const r = store.backfillScope(osDir, { scopes: ['api', 'app'], fallbackScope: 'os', apply: true });
  assert.strictEqual(r.applied, true);
  assert.ok(fs.existsSync(r.backup)); // 原本が隣に残る
  const snap = store.getSnapshot(osDir);
  assert.deepStrictEqual(snap.statements.S0001.scope, ['api']);
  assert.strictEqual(snap.statements.S0002.scope, undefined); // 宛先に依らない知識は据え置き
  assert.deepStrictEqual(snap.statements.S0003.scope, ['api', 'app']);
  assert.deepStrictEqual(snap.statements.S0004.scope, ['os']); // tagsに宛先が無いingest観測はfallback
  assert.deepStrictEqual(snap.indexes.by_scope.api, ['S0001', 'S0003']);
  // 再実行は既にscope済みを数えるだけで何も変えない
  const again = store.backfillScope(osDir, { scopes: ['api', 'app'], apply: true });
  assert.strictEqual(again.scoped, 0);
  assert.strictEqual(again.already_scoped, 3);
});

test('backfillScope: fallbackScope未指定ならingest観測も据え置き', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('S0001', 'observation', '構成観測', { tags: ['repo', 'layout'], provenance: { source: 'ingest-repo', method: 'deterministic' } }),
  ]);
  const r = store.backfillScope(osDir, { scopes: ['api'], apply: true });
  assert.strictEqual(r.scoped, 0);
  assert.strictEqual(r.left_without_scope, 1);
});

test('dryRun: 追記せず「追記されるはずだったもの」を返す（同期状態の検査用）', () => {
  const { root, osDir } = makeOs();
  const repo = repoWith(root, 'repo-a', { 'CLAUDE.md': ['# T', '前文', '', '## 規約', 'go build 禁止'].join('\n') });
  const dir = path.join(root, 'mem');
  write(dir, 'f.md', ['---', 'name: f', 'description: make fmt は禁止', 'metadata:', '  type: feedback', '---'].join('\n'));

  const dryRules = ingestRuleDocs(osDir, { scope: 'repo-a', repoRoot: repo, docs: ['CLAUDE.md'], dryRun: true });
  const dryMem = ingestMemoryIndex(osDir, { scope: 'repo-a', dir, dryRun: true });
  assert.strictEqual(dryRules.would_add.length, 2);
  assert.strictEqual(dryMem.would_add.length, 1);
  assert.deepStrictEqual(dryRules.added, []);
  assert.strictEqual(store.loadEvents(osDir).length, 0); // 1件も書かれていない

  ingestRuleDocs(osDir, { scope: 'repo-a', repoRoot: repo, docs: ['CLAUDE.md'] });
  ingestMemoryIndex(osDir, { scope: 'repo-a', dir });
  // 取込後は would_add が空 = 同期済み
  assert.deepStrictEqual(ingestRuleDocs(osDir, { scope: 'repo-a', repoRoot: repo, docs: ['CLAUDE.md'], dryRun: true }).would_add, []);
  assert.deepStrictEqual(ingestMemoryIndex(osDir, { scope: 'repo-a', dir, dryRun: true }).would_add, []);

  // 知識源が更新されたら再び would_add が立つ（更新漏れの検出）
  write(dir, 'f.md', ['---', 'name: f', 'description: make fmt は禁止（gofmtを使う）', 'metadata:', '  type: feedback', '---'].join('\n'));
  assert.strictEqual(ingestMemoryIndex(osDir, { scope: 'repo-a', dir, dryRun: true }).would_add.length, 1);
});
