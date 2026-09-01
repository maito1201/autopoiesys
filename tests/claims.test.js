'use strict';
// 宣言台帳（claims）: 納品/検収の分離・較正・信用価格・監査抽選のテスト。
// 制度の不変条件を守る:
//   - 反証手続きの無い宣言は開示なしに登録できない
//   - 外部はdeterministicの検収を名乗れない（元帳は現実だけから書かれる）
//   - brokeは較正上sticky（後からheldに直しても乖離の事実は消えない）
//   - 監査抽選は決定的（引き直しで検査を回避できない）
//   - 納品は宣言なしに通らず、剥がれた宣言があると失敗する
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write } = require('./helpers');
const claims = require('../core/claims');
const evaluate = require('../core/evaluate');

function newTask(osDir, extra = {}) {
  return evaluate.newTask(osDir, 'テストタスク', [], extra);
}

test('claim new: falsifierかunfalsifiable_reasonのどちらか一方が必須', () => {
  const { osDir } = makeOs();
  const t = newTask(osDir);
  assert.throws(() => claims.newClaim(osDir, { task: t.id, body: '主張' }), /falsifier/);
  assert.throws(() => claims.newClaim(osDir, {
    task: t.id,
    body: '主張',
    falsifier: { type: 'deferred', how: 'x' },
    unfalsifiable_reason: 'y',
  }), /同時に持てない/);
  // deferredはhow必須
  assert.throws(() => claims.newClaim(osDir, {
    task: t.id, body: '主張', falsifier: { type: 'deferred' },
  }), /how/);
  // 実在しないタスクには登録できない
  assert.throws(() => claims.newClaim(osDir, {
    task: 'T999', body: '主張', falsifier: { type: 'deferred', how: 'x' },
  }), /存在しない/);
  const c = claims.newClaim(osDir, {
    task: t.id, body: 'テストが通る', falsifier: { type: 'command', argv: ['node', '-e', ''] },
  });
  assert.strictEqual(c.id, 'C0001');
  const u = claims.newClaim(osDir, {
    task: t.id, body: '設計判断の質', unfalsifiable_reason: '好みの判断であり手続き化できない',
  });
  assert.strictEqual(claims.getClaim(osDir, u.id).state, 'pending');
});

test('settle: 実行可能な反証手続きはCoreが執行しdeterministicで記録する', () => {
  const { root, osDir } = makeOs();
  write(root, 'src/x.js', 'seen.add(key);\n');
  const t = newTask(osDir, { work_dir: root });
  const held = claims.newClaim(osDir, {
    task: t.id, body: '冪等キーがある',
    falsifier: { type: 'file_matches', path: 'src/x.js', pattern: 'seen\\.add' },
  });
  const broke = claims.newClaim(osDir, {
    task: t.id, body: 'console.logが無い',
    falsifier: { type: 'file_not_matches', path: 'src/x.js', pattern: 'seen' },
  });
  const r1 = claims.settleClaim(osDir, held.id);
  assert.strictEqual(r1.result, 'held');
  assert.strictEqual(r1.provenance, 'deterministic');
  const r2 = claims.settleClaim(osDir, broke.id);
  assert.strictEqual(r2.result, 'broke');
  const merged = claims.loadClaims(osDir).byId;
  assert.strictEqual(merged[held.id].state, 'held');
  assert.strictEqual(merged[broke.id].state, 'broke');
  assert.strictEqual(merged[broke.id].broke_ever, true);
});

test('settle: deferred/userはresult+evidence必須、deterministicは名乗れない', () => {
  const { osDir } = makeOs();
  const t = newTask(osDir);
  const c = claims.newClaim(osDir, {
    task: t.id, body: '運用で壊れない', falsifier: { type: 'deferred', how: '7日の運用' },
  });
  assert.throws(() => claims.settleClaim(osDir, c.id), /result/);
  assert.throws(() => claims.settleClaim(osDir, c.id, { result: 'held' }), /evidence/);
  const r = claims.settleClaim(osDir, c.id, {
    result: 'held', evidence: ['障害0件'], provenance: 'deterministic', source: 'ops',
  });
  // 外部からのdeterministic名乗りはllmに落とされる
  assert.strictEqual(r.provenance, 'llm');
});

test('broke: 納品済みタスクをopenへ戻し、較正ではstickyに数え続ける', () => {
  const { root, osDir } = makeOs();
  write(root, 'ok.js', 'process.exit(0);\n');
  const t = newTask(osDir, { work_dir: root });
  claims.newClaim(osDir, {
    task: t.id, body: 'コマンドが通る',
    falsifier: { type: 'command', argv: ['node', 'ok.js'] },
  });
  const deferred = claims.newClaim(osDir, {
    task: t.id, body: '設定を壊していない', falsifier: { type: 'deferred', how: '運用' },
  });
  const dv = evaluate.deliver(osDir, t.id);
  assert.strictEqual(dv.status, 'delivered');
  // 現実が剥がした → openへ戻る
  const r = claims.settleClaim(osDir, deferred.id, {
    result: 'broke', evidence: ['タイムアウト設定が壊れた'], source: 'user',
  });
  assert.strictEqual(r.reopened, true);
  assert.strictEqual(evaluate.getTask(osDir, t.id).status, 'open');
  // 後からheldに直しても、較正の乖離（broke）は消えない
  claims.settleClaim(osDir, deferred.id, { result: 'held', evidence: ['修正後の運用で安定'], source: 'user' });
  const cal = claims.calibration(osDir);
  assert.strictEqual(cal.broke, 1);
  assert.strictEqual(claims.loadClaims(osDir).byId[deferred.id].state, 'held');
});

test('deliver: 宣言なしは通らない・剥がれた宣言があると失敗する・全held即時ならsettled', () => {
  const { root, osDir } = makeOs();
  write(root, 'src/x.js', 'const a = 1;\n');
  const t = newTask(osDir, { work_dir: root });
  assert.throws(() => evaluate.deliver(osDir, t.id), /宣言が1件も無い/);
  const c = claims.newClaim(osDir, {
    task: t.id, body: 'console.logが無い',
    falsifier: { type: 'file_not_matches', path: 'src/x.js', pattern: 'console\\.log' },
  });
  // 剥がれる状態を作る
  fs.writeFileSync(path.join(root, 'src/x.js'), 'console.log(1);\n', 'utf8');
  assert.throws(() => evaluate.deliver(osDir, t.id), /剥がされた/);
  // brokeがstickyなので、直しても同じ宣言の再納品は通らない — 直した状態を新しい宣言として出す
  fs.writeFileSync(path.join(root, 'src/x.js'), 'const a = 1;\n', 'utf8');
  assert.throws(() => evaluate.deliver(osDir, t.id), /剥がされた|FIX/);
  const t2 = newTask(osDir, { work_dir: root });
  claims.newClaim(osDir, {
    task: t2.id, body: 'console.logが無い',
    falsifier: { type: 'file_not_matches', path: 'src/x.js', pattern: 'console\\.log' },
  });
  const dv = evaluate.deliver(osDir, t2.id);
  assert.strictEqual(dv.status, 'settled'); // 検収待ちが無ければ即settled
  assert.strictEqual(evaluate.nextAction(osDir, t2.id).action, 'SETTLED');
  void c;
});

test('deliver: 評価ゲートが緑でなければ通らない', () => {
  const { root, osDir } = makeOs();
  write(root, 'src/x.js', 'console.log(1);\n');
  write(osDir, 'evaluators/no_console.yaml', [
    'id: no_console',
    'applies_to: repo_change',
    'tier: T0',
    'method: deterministic',
    'checks:',
    '  - kind: file_not_matches',
    '    path: src/x.js',
    '    pattern: "console\\.log"',
  ].join('\n'));
  const t = evaluate.newTask(osDir, 'テスト', ['no_console'], { work_dir: root });
  claims.newClaim(osDir, { task: t.id, body: 'x', falsifier: { type: 'deferred', how: 'y' } });
  evaluate.evaluateTask(osDir, t.id, { workDir: root });
  assert.throws(() => evaluate.deliver(osDir, t.id), /評価ゲートが緑ではない/);
});

test('監査抽選: 決定的で、履歴不足・直近broke・非PASS実績では必ず監査する', () => {
  const { osDir } = makeOs();
  const t = newTask(osDir);
  const def = { id: 'judge_x', method: 'llm_judge', tier: 'T2', rubric: 'r' };
  // cold start（検収実績ゼロ）→ 必ず監査
  let d = claims.auditDecision(osDir, evaluate.getTask(osDir, t.id), def, { lastVerdict: null });
  assert.strictEqual(d.audit, true);
  assert.match(d.basis, /cold_start/);
  // 前回verdictが非PASS → 必ず監査
  d = claims.auditDecision(osDir, evaluate.getTask(osDir, t.id), def, { lastVerdict: { verdict: 'FAIL' } });
  assert.strictEqual(d.audit, true);
  assert.match(d.basis, /prior_non_pass/);
  // 検収実績を5件積む（全held）→ 抽選になり、p=floor(0.25)
  for (let i = 0; i < 5; i++) {
    const c = claims.newClaim(osDir, {
      task: t.id, body: `宣言${i}`, falsifier: { type: 'deferred', how: 'x' },
    });
    claims.settleClaim(osDir, c.id, { result: 'held', evidence: ['ok'], source: 'ops' });
  }
  d = claims.auditDecision(osDir, evaluate.getTask(osDir, t.id), def, { lastVerdict: null });
  assert.strictEqual(d.p, 0.25);
  assert.match(d.basis, /sampled/);
  // 抽選は決定的: 同じ状態からは常に同じ結果
  const d2 = claims.auditDecision(osDir, evaluate.getTask(osDir, t.id), def, { lastVerdict: null });
  assert.strictEqual(d.audit, d2.audit);
  assert.strictEqual(d.draw, d2.draw);
  // brokeが直近に入ると全数監査に戻る
  const cb = claims.newClaim(osDir, {
    task: t.id, body: '剥がれる宣言', falsifier: { type: 'deferred', how: 'x' },
  });
  claims.settleClaim(osDir, cb.id, { result: 'broke', evidence: ['壊れた'], source: 'user' });
  d = claims.auditDecision(osDir, evaluate.getTask(osDir, t.id), def, { lastVerdict: null });
  assert.strictEqual(d.audit, true);
  assert.match(d.basis, /recent_broke/);
});

test('trust無効化: config.trust.enabled=false で常に監査', () => {
  const { osDir } = makeOs();
  fs.appendFileSync(path.join(osDir, 'config.yaml'), 'trust:\n  enabled: false\n');
  const t = newTask(osDir);
  const def = { id: 'judge_x', method: 'llm_judge', tier: 'T2', rubric: 'r' };
  const d = claims.auditDecision(osDir, evaluate.getTask(osDir, t.id), def, { lastVerdict: null });
  assert.strictEqual(d.audit, true);
  assert.strictEqual(d.basis, 'trust_disabled');
});

test('verbatim: 原文は登録後に変更できず、判定briefingに載る', () => {
  const { root, osDir } = makeOs();
  write(root, 'src/x.js', 'const a = 1;\n');
  write(osDir, 'evaluators/judge_req.yaml', [
    'id: judge_req',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'rubric: 要件を満たすか',
  ].join('\n'));
  const t = evaluate.newTask(osDir, '実行者の言い換え', ['judge_req'], {
    work_dir: root,
    verbatim: 'ユーザーが実際に打った依頼の原文',
  });
  assert.ok(evaluate.getTask(osDir, t.id).verbatim_sha);
  assert.throws(
    () => evaluate.updateTask(osDir, t.id, { verbatim: '書き換えた原文' }),
    /変更できない/
  );
  evaluate.addArtifact(osDir, t.id, { path: 'src/x.js', note: '実装' });
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  const briefing = results.find((r) => r.briefing).briefing;
  const text = fs.readFileSync(briefing, 'utf8');
  assert.ok(text.includes('ユーザーが実際に打った依頼の原文'));
  assert.ok(text.includes('言い換え'));
  assert.ok(text.includes('納品の宣言'));
});

test('evaluateTask: 較正実績が買った監査免除はverdictを書かず、免除の記録を残す', () => {
  const { root, osDir } = makeOs();
  write(root, 'src/x.js', 'const a = 1;\n');
  write(osDir, 'evaluators/judge_req.yaml', [
    'id: judge_req',
    'applies_to: task_artifact',
    'tier: T2',
    'method: llm_judge',
    'rubric: 要件を満たすか',
  ].join('\n'));
  // 検収実績を積んで p=0.25 にする
  const t0 = newTask(osDir);
  for (let i = 0; i < 6; i++) {
    const c = claims.newClaim(osDir, {
      task: t0.id, body: `宣言${i}`, falsifier: { type: 'deferred', how: 'x' },
    });
    claims.settleClaim(osDir, c.id, { result: 'held', evidence: ['ok'], source: 'ops' });
  }
  // 抽選がsampled_outになる成果物時刻を探す（決定的なので探索も決定的）
  const t = evaluate.newTask(osDir, 'テスト', ['judge_req'], { work_dir: root });
  let sampledOut = false;
  for (let i = 0; i < 40 && !sampledOut; i++) {
    evaluate.addArtifact(osDir, t.id, { path: 'src/x.js', note: 'x', ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` });
    const task = evaluate.getTask(osDir, t.id);
    const def = evaluate.loadEvaluatorDef(osDir, 'judge_req');
    const d = claims.auditDecision(osDir, task, def, { lastVerdict: null });
    if (!d.audit) sampledOut = true;
  }
  assert.ok(sampledOut, 'p=0.25で40回の状態のうち1回も免除にならないのは抽選の欠陥');
  const { results } = evaluate.evaluateTask(osDir, t.id, { workDir: root });
  const row = results.find((r) => r.evaluator === 'judge_req');
  assert.strictEqual(row.skipped, 'sampled_out');
  // verdictは書かれていない（偽PASSを元帳に混ぜない）
  const log = path.join(osDir, 'evaluations', 'log.jsonl');
  const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  assert.ok(!rows.some((l) => l.includes('judge_req')));
  // 免除は第一級の記録として残る
  const ctx = fs.readFileSync(path.join(osDir, 'observations', 'context_log.jsonl'), 'utf8');
  assert.ok(ctx.includes('audit_sampled_out'));
  // next-actionは免除をwaivedとして扱い、missingに数えない
  const na = evaluate.nextAction(osDir, t.id);
  assert.strictEqual(na.action, 'DELIVER');
  assert.ok(na.waived.some((w) => w.evaluator === 'judge_req'));
});

test('agenda: 納品済みタスクの検収待ちの宣言が次の仕事に載る', () => {
  const { root, osDir } = makeOs();
  write(root, 'ok.js', 'process.exit(0);\n');
  const t = newTask(osDir, { work_dir: root });
  claims.newClaim(osDir, {
    task: t.id, body: '通る', falsifier: { type: 'command', argv: ['node', 'ok.js'] },
  });
  claims.newClaim(osDir, {
    task: t.id, body: '運用で壊れない',
    falsifier: { type: 'deferred', how: '7日の運用', due: '2000-01-01' },
  });
  evaluate.deliver(osDir, t.id);
  const { items } = require('../core/agenda').agenda(osDir);
  const overdue = items.find((i) => i.kind === 'overdue_claim');
  assert.ok(overdue, '期限切れの検収待ちが次の仕事に載る');
  assert.ok(overdue.action.includes('claim settle'));
});
