'use strict';
// T010で修正したCore欠陥3件の回帰テスト。
// 3件とも「テストは全通過するが、器官を実際に動かすと出る」型で、
// 共通する原因は**宣言と集計（あるいは検出）が別の場所にあり、片方だけ更新された**こと。
// したがってテストは実装の内部ではなく、**その経路が本当に通っているか**を検査する。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeOs, write } = require('./helpers');
const { computeMetrics } = require('../core/metrics');
const { initOs, missingBundledQueries, BUNDLED_QUERIES } = require('../core/scaffold');
const { checkAll } = require('../core/schema');

const OSS_ROOT = path.resolve(__dirname, '..');

// ---- 欠陥1: check-knowledge-ingested が rule_docs を必ず未取込と誤検出する ----
// ingest rules は provenance.ref に `<絶対パス>#<見出し>` を焼く（見出し単位でStatement化するため）。
// 旧実装の refKey() はフラグメントを落とさなかったので、宣言側の `<絶対パス>` と一致しなかった。
// 旧fixtureは memory 由来の ref（フラグメント無し）しか持たず、この経路を一度も通っていなかった。
test('check-knowledge-ingested: rule_docs の ref が #見出し 付きでも取込済みと判定される', () => {
  const { root, osDir } = makeOs();
  const repo = path.join(root, 'repo');
  const rules = write(repo, 'CLAUDE.md', '# 規約\n\n## アーキテクチャ\n\n本文\n');
  write(osDir, 'goal.yaml', [
    'goal: テスト', 'domain: test', 'objectives: [x]',
    'success_criteria:', '  - id: sc-001', '    statement: s', '    evaluator: unbound',
    'sources:', '  - scope: repo', `    repo: ${repo}`, '    rule_docs: [CLAUDE.md]', '',
  ].join('\n'));
  // ingest rules が実際に書く形の ref（フラグメント付き）
  fs.writeFileSync(path.join(osDir, 'world_model', 'events.jsonl'), `${JSON.stringify({
    id: 'S0001', ts: '2026-08-31T00:00:00Z', type: 'constraint', body: '規約', status: 'fact',
    provenance: { source: 'ingest-rules', method: 'deterministic', ref: `${rules}#アーキテクチャ` },
  })}\n`);

  const res = spawnSync('node', [path.join(OSS_ROOT, 'scripts', 'check-knowledge-ingested.js'), osDir],
    { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(res.status, 0, `合格すべきだが不合格: ${res.stdout}`);
  assert.match(res.stdout, /ok: 宣言された知識源1件/);
});

test('check-knowledge-ingested: 本当に取り込まれていない rule_docs は依然として違反になる（検出力）', () => {
  const { root, osDir } = makeOs();
  const repo = path.join(root, 'repo');
  write(repo, 'CLAUDE.md', '# 規約\n');
  write(osDir, 'goal.yaml', [
    'goal: テスト', 'domain: test', 'objectives: [x]',
    'success_criteria:', '  - id: sc-001', '    statement: s', '    evaluator: unbound',
    'sources:', '  - scope: repo', `    repo: ${repo}`, '    rule_docs: [CLAUDE.md]', '',
  ].join('\n'));
  fs.writeFileSync(path.join(osDir, 'world_model', 'events.jsonl'), '');

  const res = spawnSync('node', [path.join(OSS_ROOT, 'scripts', 'check-knowledge-ingested.js'), osDir],
    { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(res.status, 1, '未取込を見逃してはならない');
  assert.match(res.stdout, /World Modelに取り込まれていない/);
});

// ---- 欠陥2: 同梱Queryが既存の .os に届かない ----
// init は writeIfAbsent 方式なので、Coreが後から増やしたQueryは既にある .os に永久に入らない。
// 不足は「Queryが足りない」ではなく「Core更新が届いていない」なので、そう名指しできること。
test('scaffold: 同梱Queryは init で全件置かれ、欠けていれば missingBundledQueries が名指しする', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const { osDir } = initOs(ws);
  const names = Object.keys(BUNDLED_QUERIES).sort();
  assert.ok(names.includes('get_past_decisions') && names.includes('get_decision_outcomes'));
  for (const n of names) {
    assert.ok(fs.existsSync(path.join(osDir, 'queries', `${n}.yaml`)), `${n} が置かれていない`);
  }
  assert.deepStrictEqual(missingBundledQueries(osDir), []);

  fs.rmSync(path.join(osDir, 'queries', 'get_decision_outcomes.yaml'));
  assert.deepStrictEqual(missingBundledQueries(osDir), ['get_decision_outcomes']);
});

// **この族の不変条件**: Coreが自分で書き込む型は、必ずどれかの同梱Queryが返せること。
// 個別のQueryを1本ずつテストしても、Coreが新しい型を書き始めた瞬間に同じ穴がまた開く。
// 実際に outcome（decision outcome）と evidence（task consolidate）の2回、
// 「器官を使った瞬間に wm_reachability が落ちる」という同じ形で表面化した。
// **学習を前へ進める操作が検査を壊す向きになってはいけない。**
test('同梱Query: Coreが書き込む型（decision/outcome/evidence/unknown）はすべて到達可能', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const { osDir } = initOs(ws);
  const { auditReachability } = require('../core/query');
  const base = { ts: '2026-08-31T00:00:00Z', status: 'fact', provenance: { source: 'test', method: 'human' } };
  const rows = [
    { ...base, id: 'S0001', type: 'decision', body: 'Aを選ぶ', situation: '場', chosen: 'A', options: ['A', 'B'] },
    { ...base, id: 'S0002', type: 'outcome', body: '結果: met', decision: 'S0001', result: 'met', links: [{ role: 'derived_from', to: 'S0001' }] },
    { ...base, id: 'S0003', type: 'lesson', body: '教訓', when: '場面' },
    { ...base, id: 'S0004', type: 'evidence', body: 'T001でこの教訓が有効だった', links: [{ role: 'supports', to: 'S0003' }] },
    { ...base, id: 'S0005', type: 'unknown', status: 'unknown', body: '未解決の不足' },
  ];
  fs.writeFileSync(path.join(osDir, 'world_model', 'events.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const unreachable = auditReachability(osDir).unreachable;
  // lesson(S0003) は領域Queryが引く前提でCoreは同梱しないため、対象から外す
  const coreWritten = ['S0001', 'S0002', 'S0004', 'S0005'];
  const missed = coreWritten.filter((id) => unreachable.includes(id));
  assert.deepStrictEqual(missed, [],
    `Coreが書く型が同梱Queryから引けない: ${missed.join(', ')} — その器官を使った瞬間に wm_reachability が落ちる`);
});

test('check: 同梱Queryの欠落を警告として出す（Core更新が既存の.osに届いていない）', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const { osDir } = initOs(ws);
  assert.ok(!checkAll(osDir).warnings.some((w) => /同梱するQuery/.test(w)), '揃っているのに警告してはならない');

  fs.rmSync(path.join(osDir, 'queries', 'get_past_decisions.yaml'));
  const w = checkAll(osDir).warnings.find((x) => /同梱するQuery/.test(x));
  assert.ok(w, '欠落を警告していない');
  assert.match(w, /get_past_decisions/);
});

test('get_decision_outcomes: 決定の結果がトップレベル行として引ける（expandのlinkedでは到達性を満たさない）', () => {
  const { osDir } = makeOs();
  const { runQuery, auditReachability } = require('../core/query');
  const rows = [
    {
      id: 'S0001', ts: '2026-08-31T00:00:00Z', type: 'decision', body: 'Aを選ぶ', status: 'fact',
      situation: '場', chosen: 'A', options: ['A', 'B'],
      provenance: { source: 'decision', method: 'human' },
    },
    {
      id: 'S0002', ts: '2026-08-31T00:01:00Z', type: 'outcome', body: '結果: met', status: 'fact',
      decision: 'S0001', result: 'met', links: [{ role: 'derived_from', to: 'S0001' }],
      provenance: { source: 'decision-review', method: 'human' },
    },
  ];
  fs.writeFileSync(path.join(osDir, 'world_model', 'events.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const r = runQuery(osDir, 'get_decision_outcomes', {}, { log: false });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.results[0].id, 'S0002');
  assert.strictEqual(r.results[0].result, 'met');
  // 到達性: outcome が unreachable にならない（これが無いと wm_reachability が必ず落ちた）
  assert.ok(!auditReachability(osDir).unreachable.includes('S0002'));
});

// ---- 欠陥3: metrics が tokens_total を集計しない ----
// ledger add の usage は「内訳が分からない実測（サブエージェントの消費合計など）は
// --tokens-total を使う」と案内しているのに、集計側は tokens_in/out しか見ていなかった。
// その結果、実測を入れられる唯一の経路が捨てられ measured は永久に0だった。
test('metrics: tokens_total だけの行が measured に集計される', () => {
  const { osDir } = makeOs();
  const costs = [
    { ts: '2026-08-31T00:00:00Z', purpose: 'judge:a', tier: 'T1', task: 'T001', tokens_total: 1000, estimated: false },
    { ts: '2026-08-31T00:01:00Z', purpose: 'judge:b', tier: 'T2', task: 'T001', tokens_in: 10, tokens_out: 5, estimated: false },
    { ts: '2026-08-31T00:02:00Z', purpose: 'plan', tier: 'T2' },
  ];
  fs.writeFileSync(path.join(osDir, 'observations', 'costs.jsonl'),
    costs.map((c) => JSON.stringify(c)).join('\n') + '\n');

  const m = computeMetrics(osDir);
  assert.strictEqual(m.tokens.measured, 1015, 'tokens_total が measured に入っていない');
  assert.strictEqual(m.tokens.total, 1015);
  assert.strictEqual(m.tokens.entries_without_tokens, 1, 'トークン欄が無い行だけを数えること');
  assert.strictEqual(m.tokens.by_tier.T1, 1000);
  assert.strictEqual(m.tokens.by_task.T001, 1015);
});

test('metrics: 内訳と合計が両方ある行は合計を採る（両立は矛盾なので一方に倒すことを固定する）', () => {
  const { osDir } = makeOs();
  fs.writeFileSync(path.join(osDir, 'observations', 'costs.jsonl'), `${JSON.stringify({
    ts: '2026-08-31T00:00:00Z', purpose: 'x', tier: 'T1', tokens_in: 1, tokens_out: 2, tokens_total: 99, estimated: false,
  })}\n`);
  assert.strictEqual(computeMetrics(osDir).tokens.measured, 99);
});

test('metrics: estimated が false でない tokens_total は見積り側に数える', () => {
  const { osDir } = makeOs();
  fs.writeFileSync(path.join(osDir, 'observations', 'costs.jsonl'), `${JSON.stringify({
    ts: '2026-08-31T00:00:00Z', purpose: 'x', tier: 'T1', tokens_total: 500,
  })}\n`);
  const m = computeMetrics(osDir);
  assert.strictEqual(m.tokens.measured, 0);
  assert.strictEqual(m.tokens.estimated, 500);
});
