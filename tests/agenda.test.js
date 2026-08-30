'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeOs, write, statement } = require('./helpers');
const store = require('../core/store');
const failure = require('../core/failure');
const evaluate = require('../core/evaluate');
const { agenda, agendaReport } = require('../core/agenda');

// makeOsが生成するgoal.yamlスタブにはunboundな基準が含まれ、それ自体が正当な
// agenda項目になる。「未処理の仕事が無いOS」を作るテストではスタブを外す。
function makeBareOs() {
  const made = makeOs();
  fs.rmSync(path.join(made.osDir, 'goal.yaml'));
  return made;
}

test('空のOSでは空のitemsと空報告メッセージが返る', () => {
  const { osDir } = makeBareOs();
  const { items, warnings } = agenda(osDir);
  assert.deepStrictEqual(items, []);
  assert.deepStrictEqual(warnings, []);
  const lines = agendaReport(osDir);
  assert.strictEqual(lines[0], '## 次にやるべき仕事（OSの状態から機械的に導出。優先度は決定的な近似）');
  assert.ok(lines.some((l) => l.includes('未処理の仕事は無い。新しいタスクか、golden taskの拡充を検討せよ')));
});

test('unknown: importance×(1+blocks数)で採点され、blocksがwhyに出る', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('U1', 'unknown', '閾値が不明', {
      status: 'unknown', importance: 0.5, blocks: ['D001', 'sc-001'],
    }),
    statement('U2', 'unknown', 'importance未設定の不明', { status: 'unknown' }),
    statement('U3', 'unknown', '撤回済みの不明', { status: 'retracted' }),
  ]);
  const { items } = agenda(osDir);
  const u1 = items.find((i) => i.ref === 'U1');
  const u2 = items.find((i) => i.ref === 'U2');
  assert.strictEqual(u1.kind, 'unknown');
  assert.strictEqual(u1.score, 0.5 * (1 + 2));
  assert.ok(u1.why.includes('D001, sc-001'));
  assert.ok(u1.action.includes('statement supersede U1'));
  // importance無しは既定0.3、blocks無しは×1
  assert.strictEqual(u2.score, 0.3);
  // retractedは出ない
  assert.strictEqual(items.find((i) => i.ref === 'U3'), undefined);
});

test('failure: 非終端だけがseverityで採点され、次に許される遷移がwhyに出る', () => {
  const { osDir } = makeOs();
  const f1 = failure.report(osDir, { symptom: '高い症状', severity: 'high' }).entry;
  const f2 = failure.report(osDir, { symptom: '普通の症状' }).entry; // severity既定medium
  const f3 = failure.report(osDir, { symptom: '受容済みの症状', severity: 'low' }).entry;
  failure.transition(osDir, f3.id, 'accepted_risk', {
    reason: 'テスト用', why_undetected: 'テスト用',
  });
  const { items } = agenda(osDir);
  const i1 = items.find((i) => i.ref === f1.id);
  const i2 = items.find((i) => i.ref === f2.id);
  assert.strictEqual(i1.kind, 'failure');
  assert.strictEqual(i1.score, 1.0);
  assert.strictEqual(i2.score, 0.6);
  assert.ok(i1.why.includes('reportedのまま'));
  assert.ok(i1.why.includes('investigated'));
  assert.ok(i1.action.includes('/investigate-failure'));
  // 終端（accepted_risk）は出ない
  assert.strictEqual(items.find((i) => i.ref === f3.id), undefined);
});

test('反証された教訓: countersがsupportsを上回るlessonだけが出る', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('L1', 'lesson', '外れた教訓', { when: 'テスト時', task_class: 'abcd1234' }),
    statement('L2', 'lesson', '効いている教訓', { when: 'テスト時', task_class: 'abcd1234' }),
    statement('E1', 'evidence', 'misled観測1', { links: [{ role: 'counters', to: 'L1' }] }),
    statement('E2', 'evidence', 'misled観測2', { links: [{ role: 'counters', to: 'L1' }] }),
    statement('E3', 'evidence', 'helped観測', { links: [{ role: 'supports', to: 'L1' }] }),
    statement('E4', 'evidence', 'helped観測', { links: [{ role: 'supports', to: 'L2' }] }),
    statement('E5', 'evidence', 'misled観測', { links: [{ role: 'counters', to: 'L2' }] }),
  ]);
  const { items } = agenda(osDir);
  const l1 = items.find((i) => i.ref === 'L1');
  assert.strictEqual(l1.kind, 'contested_lesson');
  assert.strictEqual(l1.score, 0.7);
  assert.ok(l1.why.includes('counters 2 > supports 1'));
  assert.ok(l1.action.includes('statement supersede L1'));
  // 同数（1:1）は反証扱いしない
  assert.strictEqual(items.find((i) => i.ref === 'L2'), undefined);
});

test('doneなのにconsolidatedが無いタスクだけが出る', () => {
  const { osDir } = makeOs();
  const t1 = evaluate.newTask(osDir, '蒸留されていない完了タスク', []);
  evaluate.updateTask(osDir, t1.id, { status: 'done' });
  const t2 = evaluate.newTask(osDir, '蒸留済みの完了タスク', []);
  evaluate.updateTask(osDir, t2.id, { status: 'done', consolidated: { ts: '2026-08-29T00:00:00Z', lessons: ['L1'] } });
  const t3 = evaluate.newTask(osDir, '進行中タスク', []);
  const { items } = agenda(osDir);
  const i1 = items.find((i) => i.ref === t1.id);
  assert.strictEqual(i1.kind, 'unconsolidated_task');
  assert.strictEqual(i1.score, 0.5);
  assert.ok(i1.action.includes(`task consolidate ${t1.id}`));
  assert.strictEqual(items.find((i) => i.ref === t2.id), undefined);
  assert.strictEqual(items.find((i) => i.ref === t3.id), undefined);
});

test('goal.yamlのunboundな基準がunmeasured_criterionとして出る', () => {
  const { osDir } = makeOs();
  write(osDir, 'goal.yaml', [
    'goal: テスト用の目的',
    'domain: software_engineering',
    'objectives:',
    '  - o1',
    'success_criteria:',
    '  - id: sc-001',
    '    statement: 測れていない基準',
    '    evaluator: unbound',
    'constraints:',
    '  - id: c-001',
    '    statement: 判定器の実体が無い制約',
    '    evaluator: ghost_evaluator',
  ].join('\n'));
  const { items } = agenda(osDir);
  const sc = items.find((i) => i.ref === 'success_criteria:sc-001');
  const c = items.find((i) => i.ref === 'constraints:c-001');
  assert.strictEqual(sc.kind, 'unmeasured_criterion');
  assert.strictEqual(sc.score, 0.4);
  assert.ok(sc.why.includes('この基準は測れていない'));
  assert.ok(sc.action.includes('/build-evaluation-model'));
  assert.strictEqual(c.score, 0.4);
  assert.ok(c.why.includes('ghost_evaluator'));
});

test('proposals/に残るファイルが未消化の提案として出る', () => {
  const { osDir } = makeOs();
  write(osDir, 'proposals/F001-evaluator.yaml', 'id: f001_detector\n');
  const { items } = agenda(osDir);
  const p = items.find((i) => i.ref === 'proposals/F001-evaluator.yaml');
  assert.strictEqual(p.kind, 'proposal');
  assert.strictEqual(p.score, 0.3);
  assert.ok(p.why.startsWith('消化されていない提案'));
  assert.ok(p.action.includes('/upgrade-os'));
});

// 提案ファイルは適用後も残る（適用の記録）。ファイルの存在を未消化と読むと、
// 適用済みの提案が永久に次の仕事として出続ける（liveのOSで実際に起きていた）
test('提案の消化判定はFailure台帳に委ねる: terminalなら出ない・非terminalなら出る', () => {
  const { osDir } = makeOs();
  const f = failure.report(osDir, { symptom: '症状', severity: 'low' }).entry;
  write(osDir, `proposals/${f.id}-upgrade.md`, '提案本文');
  const before = agenda(osDir).items.find((i) => i.ref === `proposals/${f.id}-upgrade.md`);
  assert.ok(before, '非terminalなFailureの提案は未消化として出る');
  assert.ok(before.why.includes(f.id));
  failure.transition(osDir, f.id, 'accepted_risk', { reason: 'テスト用', why_undetected: 'テスト用' });
  const after = agenda(osDir).items.find((i) => i.ref === `proposals/${f.id}-upgrade.md`);
  assert.strictEqual(after, undefined, 'terminalなFailureの提案は未消化として出ない');
});

// Failure IDを名に含まないファイルは消化済みかを機械判定できない。
// 「判定できない」を「消化済み」に丸めない（黙って消えるのが一番危ない）
test('Failure IDを名に含まない提案は、判定不能である旨を添えて出し続ける', () => {
  const { osDir } = makeOs();
  write(osDir, 'proposals/idea.md', '提案本文');
  const p = agenda(osDir).items.find((i) => i.ref === 'proposals/idea.md');
  assert.ok(p);
  assert.ok(p.why.includes('機械判定できない'));
});

// agendaが着手中を知らないと、次の仕事を聞くたびに、いま自分がやっている仕事を勧める
test('着手中の項目はin_flightが付いてスコアが下がる（消えはしない）', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('U9', 'unknown', '着手対象の不明', { status: 'unknown', importance: 0.5 }),
  ]);
  const beforeItem = agenda(osDir).items.find((i) => i.ref === 'U9');
  assert.strictEqual(beforeItem.score, 0.5);
  assert.strictEqual(beforeItem.in_flight, undefined);
  const t = evaluate.newTask(osDir, 'U9を調べる', [], { origin: 'unknown:U9' });
  const during = agenda(osDir).items.find((i) => i.ref === 'U9');
  assert.deepStrictEqual(during.in_flight, [t.id]);
  assert.ok(during.score < beforeItem.score);
  assert.ok(during.why.includes(t.id));
  evaluate.updateTask(osDir, t.id, { status: 'done' });
  const afterItem = agenda(osDir).items.find((i) => i.ref === 'U9');
  assert.strictEqual(afterItem.in_flight, undefined);
  assert.strictEqual(afterItem.score, 0.5);
});

test('並びはscore降順・同点はref昇順で、2回呼んでも同一（決定性）', () => {
  const { osDir } = makeBareOs();
  // 同点0.3を2件（proposal）と、それより高いunknown 0.5×2=1.0相当を混ぜる
  write(osDir, 'proposals/b-second.yaml', 'x\n');
  write(osDir, 'proposals/a-first.yaml', 'x\n');
  store.assertStatements(osDir, [
    statement('U1', 'unknown', '重要な不明', { status: 'unknown', importance: 0.5, blocks: ['D001'] }),
  ]);
  const first = agenda(osDir);
  const second = agenda(osDir);
  assert.deepStrictEqual(first, second);
  const refs = first.items.map((i) => i.ref);
  assert.deepStrictEqual(refs, ['U1', 'proposals/a-first.yaml', 'proposals/b-second.yaml']);
  const scores = first.items.map((i) => i.score);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i]);
});

test('材料の一種が壊れていても全体は返り、warningsで申告される', () => {
  const { osDir } = makeOs();
  store.assertStatements(osDir, [
    statement('U1', 'unknown', '健全な不明', { status: 'unknown' }),
  ]);
  // Failure台帳を不正JSONで壊す → Failure種だけスキップされ、unknownは生きる
  fs.mkdirSync(path.join(osDir, 'failures'), { recursive: true });
  fs.writeFileSync(path.join(osDir, 'failures', 'ledger.jsonl'), '{壊れたJSON\n', 'utf8');
  const { items, warnings } = agenda(osDir);
  assert.ok(items.find((i) => i.ref === 'U1'));
  assert.strictEqual(items.find((i) => i.kind === 'failure'), undefined);
  assert.ok(warnings.some((w) => w.includes('Failure') && w.includes('スキップ')));
  // 報告にも警告が出る
  const lines = agendaReport(osDir);
  assert.ok(lines.some((l) => l.startsWith('警告:')));
});

test('agendaReport: limitで件数が絞られ、超過分は件数で示される', () => {
  const { osDir } = makeBareOs();
  write(osDir, 'proposals/p1.yaml', 'x\n');
  write(osDir, 'proposals/p2.yaml', 'x\n');
  write(osDir, 'proposals/p3.yaml', 'x\n');
  const lines = agendaReport(osDir, { limit: 2 });
  assert.strictEqual(lines[0], '## 次にやるべき仕事（OSの状態から機械的に導出。優先度は決定的な近似）');
  const numbered = lines.filter((l) => /^\d+\. \[/.test(l));
  assert.strictEqual(numbered.length, 2);
  assert.ok(lines.some((l) => l.includes('他 1 件')));
  // 各行にscore・kind・ref・actionが揃っている
  assert.ok(numbered[0].includes('[0.30] proposal proposals/p1.yaml'));
  assert.ok(lines.some((l) => l.trim().startsWith('→')));
});

test('完了タスクで下した結果未記録の決定が unreviewed_decision として出る', () => {
  const { osDir } = makeOs();
  const decision = require('../core/decision');
  const done = evaluate.newTask(osDir, '終わった仕事', []);
  evaluate.updateTask(osDir, done.id, { status: 'done' });
  const open = evaluate.newTask(osDir, '進行中の仕事', []);
  const d1 = decision.newDecision(osDir, '完了タスクで下した決定', {
    situation: 'キューの実装方式を選ぶ', chosen: 'redis', task: done.id, source: 'test',
  });
  const d2 = decision.newDecision(osDir, '進行中タスクで下した決定', {
    situation: '監視の粒度を選ぶ', chosen: '1分', task: open.id, source: 'test',
  });
  const items = agenda(osDir).items;
  const hit = items.find((i) => i.ref === d1.id);
  assert.strictEqual(hit.kind, 'unreviewed_decision');
  assert.strictEqual(hit.score, 0.45);
  assert.ok(hit.why.includes('キューの実装方式を選ぶ'));
  assert.ok(hit.action.includes(`decision outcome ${d1.id}`));
  // まだ結果が知れない（タスクが終わっていない）決定は出さない
  assert.strictEqual(items.find((i) => i.ref === d2.id), undefined);

  // 結果を記録すると消える
  decision.recordOutcome(osDir, d1.id, { result: 'met', source: 'test' });
  assert.strictEqual(agenda(osDir).items.find((i) => i.ref === d1.id), undefined);
});

// --- 材料h: 一度も動いていない器官（F011）
// 「器官が正しく動くか」（テスト）と「成果物が要件を満たすか」（evaluator）の2層はあったが、
// 「器官が実際に使われたか」を見る層が無く、policy=0件・decision outcome=0件が
// 3文脈・15タスクのあいだ誰にも名指しされなかった。
// ループを1周したOSを作る。1周する前は器官が動いていなくて当たり前なので、
// dead_organ はそもそも出ない（初日のOSに負債を並べても事実を薄めるだけ）
function makeOperatedOs() {
  const { osDir } = makeOs();
  const t = evaluate.newTask(osDir, '1周したタスク', []);
  evaluate.updateTask(osDir, t.id, { status: 'done', last_action: 'DONE' });
  return osDir;
}

test('dead_organ: 仕事を1周する前は何も出さない', () => {
  const { osDir } = makeOs();
  assert.deepStrictEqual(agenda(osDir).items.filter((i) => i.kind === 'dead_organ'), []);
});

test('dead_organ: 記録が0件の器官を名指しし、記録があれば消える', () => {
  const osDir = makeOperatedOs();
  const items = () => agenda(osDir).items.filter((i) => i.kind === 'dead_organ').map((i) => i.ref);
  // 1周した後も記録が0件なら、表に載せた器官が出る
  assert.ok(items().includes('organ/delivered_context'));
  assert.ok(items().includes('organ/claim_audit'));
  // 記録が1件でもあれば消える（強制はしない — 出すのは事実だけ）
  fs.appendFileSync(
    path.join(osDir, 'observations', 'context_log.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', kind: 'context', task: 'T001', tokens_est: 10 }) + '\n'
  );
  assert.ok(!items().includes('organ/delivered_context'));
  assert.ok(items().includes('organ/claim_audit'), '他の器官は独立に判定される');
});

// F008の教訓: 抽出不能を「違反ゼロ」と報告する検出器は、壊れたまま緑を出し続ける。
// 読めない記録を0件（＝器官が動いていない）と読むのは、その逆向きの同じ誤りである。
test('dead_organ: 記録が読めないときは0件と数えず、警告として出す', () => {
  const osDir = makeOperatedOs();
  fs.appendFileSync(path.join(osDir, 'observations', 'context_log.jsonl'), '{壊れた行\n');
  const r = agenda(osDir);
  assert.ok(r.warnings.some((w) => w.includes('動いていない器官')), r.warnings.join(' / '));
  assert.strictEqual(r.items.filter((i) => i.kind === 'dead_organ').length, 0);
});
