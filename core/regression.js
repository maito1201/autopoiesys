'use strict';
// OS Regression（設計原則§17）: golden task全件 + failure lint + 整合検査。
// llm_judgeはreplay（記録済みverdict）に置換され、回帰は決定的に走る。
// fixture付きcheckは検出力テスト（既知の悪い状態に対して検出器が実際にFAILを出せるか）。
const path = require('node:path');
const fs = require('node:fs');
const {
  loadEvaluatorDef, runDeterministic, runCommand, loadTasks, latestVerdicts,
  artifactsIncludeImplementation,
} = require('./evaluate');
const { listGoldenTasks, checkAll, loadConfig } = require('./schema');
const { readJsonl, appendJsonl, nowIso } = require('./util');
const { loadFailures, TERMINAL } = require('./failure');

function regressionLog(osDir) {
  return path.join(osDir, 'observations', 'regression.jsonl');
}
const { listQueries, loadQueryDef, runQuery } = require('./query');

// Query定義に添付されたgolden（期待件数）を検証する — Query自体を回帰対象にする
function runQueryGoldens(osDir) {
  const results = [];
  for (const name of listQueries(osDir)) {
    let def;
    try {
      def = loadQueryDef(osDir, name);
    } catch {
      continue; // 定義エラーはcheckAll側で報告される
    }
    if (!def.golden) continue;
    try {
      const r = runQuery(osDir, name, def.golden.params || {});
      const checks = [];
      if (def.golden.expect_min_count !== undefined) {
        checks.push({ rule: `total >= ${def.golden.expect_min_count}`, ok: r.total >= def.golden.expect_min_count });
      }
      if (def.golden.expect_count !== undefined) {
        checks.push({ rule: `total == ${def.golden.expect_count}`, ok: r.total === def.golden.expect_count });
      }
      results.push({ query: name, total: r.total, checks, pass: checks.every((c) => c.ok) });
    } catch (e) {
      results.push({ query: name, checks: [], pass: false, error: e.message });
    }
  }
  return results;
}

// fixture付きcommand checkのスクリプト解決（F008）。
// fixtureをcwdにして実行すると、evaluatorのargvにある相対パス（scripts/check-X.js）は
// fixtureの中に解決される。するとfixtureは検出器の複製を持たなければ動かず、
// その複製はfixture作成時点で凍結される — 本体の検出器を書き換えても golden は
// 複製に対してPASSを出し続け、検出力テストは自分自身のスナップショットを検証する。
//
// ここでは**実行するスクリプトだけ**をrepoRoot側の絶対パスに解決し、cwdはfixtureのままにする。
// データ引数（'.os' や '.'）はfixtureを指し続ける必要があるからである。
// fixture内のデータ複製（SCHEMA.md・core/store.js等）は検査対象の入力であって影ではない。
function resolveScriptAgainstRepo(def, repoRoot, fixtureDir) {
  if (def.method !== 'command' || !Array.isArray(def.argv) || def.argv.length < 2) return null;
  const argv = def.argv.map((a) => String(a));
  if (argv[0] !== 'node' || path.isAbsolute(argv[1])) return null;
  const inRepo = path.resolve(repoRoot, argv[1]);
  if (!fs.existsSync(inRepo)) return null;
  const shadow = path.resolve(fixtureDir, argv[1]);
  const next = argv.slice();
  next[1] = inRepo;
  // 何を実行したかをverdictの記録に残す。これが無いと、影を踏んでいても緑のまま通る
  const note = fs.existsSync(shadow)
    ? `実行したスクリプト: ${inRepo}（fixture内に同名の複製があるが実行していない: ${shadow}）`
    : `実行したスクリプト: ${inRepo}`;
  return { def: { ...def, argv: next }, note };
}

function runGoldenCheck(osDir, check, { repoRoot }) {
  const def = loadEvaluatorDef(osDir, check.evaluator);
  const expected = check.expected || check.replay;
  let actual;
  let evidence;
  if (check.replay) {
    // llm_judge等の記録済みverdictをリプレイ（実LLMは呼ばない）
    actual = check.replay;
    evidence = ['replay'];
  } else if (def.method === 'llm_judge') {
    actual = 'UNCERTAIN';
    evidence = ['llm_judgeはregressionではreplay必須（checkにreplay: <verdict>を記録する）'];
  } else {
    const workDir = check.fixture ? path.resolve(repoRoot, check.fixture) : repoRoot;
    if (check.fixture && !fs.existsSync(workDir)) {
      return { evaluator: check.evaluator, expected, actual: 'UNCERTAIN', pass: false, evidence: [`fixtureが存在しない: ${check.fixture}`] };
    }
    let runDef = def;
    let scriptNote = null;
    if (check.fixture) {
      const resolved = resolveScriptAgainstRepo(def, repoRoot, workDir);
      if (resolved) {
        runDef = resolved.def;
        scriptNote = resolved.note;
      } else if (def.method === 'command') {
        // 解決できない形（node以外の実行体・絶対パス）を黙って落とさない。
        // 静かなフォールバックは、F008が起きた経路そのものである
        scriptNote = 'note: 実行スクリプトを本体側へ解決していない（argvがnodeスクリプトの相対パスでない）。'
          + 'fixture内に同名のファイルがあればそちらが実行される';
      }
    }
    const r = def.method === 'deterministic'
      ? runDeterministic(osDir, runDef, { workDir })
      : runCommand(runDef, { workDir });
    actual = r.verdict;
    evidence = scriptNote ? [scriptNote, ...r.evidence] : r.evidence;
  }
  return {
    evaluator: check.evaluator,
    fixture: check.fixture,
    expected,
    actual,
    pass: actual === expected,
    evidence,
  };
}

function runRegression(osDir, { repoRoot, now } = {}) {
  const root = repoRoot || process.cwd();
  const cfg = loadConfig(osDir);
  const golden = [];
  for (const { file, def } of listGoldenTasks(osDir)) {
    if (!def) {
      golden.push({ id: path.basename(file), pass: false, checks: [], error: '読込失敗' });
      continue;
    }
    const checks = (def.checks || []).map((c) => runGoldenCheck(osDir, c, { repoRoot: root }));
    golden.push({
      id: def.id,
      origin_failure: def.origin_failure,
      checks,
      pass: checks.length > 0 && checks.every((c) => c.pass),
    });
  }
  const queryGoldens = runQueryGoldens(osDir);
  const check = checkAll(osDir, { now });
  const failureLint = check.failure_lint || [];
  const pass = golden.every((g) => g.pass)
    && queryGoldens.every((q) => q.pass)
    && failureLint.length === 0
    && check.errors.length === 0;
  const result = {
    pass,
    golden_total: golden.length,
    golden_passed: golden.filter((g) => g.pass).length,
    golden,
    query_goldens: queryGoldens,
    failure_lint: failureLint,
    check_errors: check.errors,
    check_warnings: check.warnings,
    os_version: cfg.os_version,
  };
  // 実行履歴を記録する（maintenanceHintsの「そろそろregression」判定の基準になる）
  appendJsonl(regressionLog(osDir), {
    ts: now || nowIso(),
    pass,
    golden_passed: result.golden_passed,
    golden_total: result.golden_total,
    failure_lint_count: failureLint.length,
    os_version: cfg.os_version,
  });
  return result;
}

// 開いているタスクのうち、宣言済みevaluatorのverdictが揃っていないもの。
// 「評価器を一度も呼ばずに完成報告した」を決定的に検出する手掛かり。
function openTasksWithoutVerdicts(osDir) {
  const rows = [];
  let tasks;
  try {
    tasks = loadTasks(osDir);
  } catch {
    return rows;
  }
  for (const t of Object.values(tasks)) {
    if (t.status && t.status !== 'open') continue; // done も withdrawn も対象外
    const declared = t.evaluators || [];
    if (!declared.length) continue;
    const latest = latestVerdicts(osDir, t.id);
    const missing = declared.filter((e) => !latest[e]);
    if (missing.length) rows.push({ id: t.id, missing });
  }
  return rows;
}

// 実装を作ったのに、評価にはその文書だけを渡しているタスク。
// llm_judgeは渡されたartifactしか読めないので、文書だけを渡すと判定者は
// 「作業そのもの」ではなく「作業についての文章」を見ることになり、
// 実装の欠陥はどの評価器も検出できないまま完了扱いになる。
function openTasksJudgingProseOnly(osDir) {
  const rows = [];
  let tasks;
  try {
    tasks = loadTasks(osDir);
  } catch {
    return rows;
  }
  for (const t of Object.values(tasks)) {
    if (t.status && t.status !== 'open') continue; // done も withdrawn も対象外
    if (!(t.artifacts || []).length) continue;      // 未登録は「評価が未実行」側で拾う
    const judges = (t.evaluators || []).filter((id) => {
      try {
        return loadEvaluatorDef(osDir, id).method === 'llm_judge';
      } catch {
        return false;
      }
    });
    if (!judges.length) continue;
    if (artifactsIncludeImplementation(osDir, t)) continue;
    rows.push({ id: t.id, judges });
  }
  return rows;
}

// 普段のコマンド実行のついでに出す運用ヒント。マニュアルを読まないユーザーに
// 「そろそろregression」「評価が未実行」を届けるための決定的チェック（LLMゼロ）。
function maintenanceHints(osDir, { now } = {}) {
  const hints = [];
  let cfg;
  try {
    cfg = loadConfig(osDir);
  } catch {
    return hints;
  }
  const nowMs = now ? Date.parse(now) : Date.now();
  const everyDays = cfg.regression_every_days || 7;
  const staleDays = cfg.stale_after_days || 7;
  const cmd = 'node cli/index.js regression';

  const runs = readJsonl(regressionLog(osDir));
  const last = runs[runs.length - 1];
  const hasAssets = listGoldenTasks(osDir).length > 0 || Object.keys(loadFailures(osDir)).length > 0;
  if (!last) {
    if (hasAssets) hints.push(`ヒント: regressionが一度も実行されていない。 ${cmd} の実行を推奨`);
  } else {
    const days = Math.floor((nowMs - Date.parse(last.ts)) / 86400000);
    if (days >= everyDays) {
      hints.push(`ヒント: 前回のregressionから${days}日経過（推奨間隔${everyDays}日）。 ${cmd} の実行を推奨`);
    }
  }

  // 未評価のまま開いているタスク。評価器を呼ばずに完了報告できてしまう穴を、
  // 報告の文面ではなくCLI出力（Skillが中継を義務づけられている経路）で塞ぐ。
  for (const t of openTasksJudgingProseOnly(osDir)) {
    hints.push(
      `警告: ${t.id} のartifactに実装（ソースコード）が1件も無い。` +
      `llm_judge（${t.judges.join(', ')}）は渡されたファイルしか読めないので、` +
      '実装の欠陥はどの評価器も検出できない。' +
      `実装を node cli/index.js task artifact ${t.id} --path <実装のパス> で登録すること`
    );
  }

  // 完了したのに蒸留されていないタスク。経験が生ログのまま消えかけている状態を
  // 黙って通すと、次に同種の仕事をするセッションはまたゼロから考えることになる
  try {
    for (const t of require('./taskclass').unconsolidatedDone(osDir)) {
      hints.push(
        `警告: ${t.id} は完了したが何を学んだか未記録。` +
        `node cli/index.js task consolidate ${t.id} --lessons <S00x,...> で蒸留するか、` +
        '--none-learned "<理由>" で学びなしを開示すること'
      );
    }
  } catch {
    // taskclass未整備でも主機能を止めない
  }

  // 完了したタスクで下した決定のうち、結果が未記録のもの。催促の契機は日付ではなく
  // 「そのタスクが終わったこと」— 期待どおりになったかを知れるようになった瞬間である。
  // ここが繋がっていないと、決定は書かれるだけで照合されず、方針（推論なしの直感）は
  // 永久にコンパイルされない（実測: この配線を入れる直前、決定6件すべてが結果未記録で方針0件だった）
  try {
    const tasksById = require('./evaluate').loadTasks(osDir);
    const byFp = require('./policy').foldByFingerprint(osDir);
    const pending = [];
    for (const fp of Object.keys(byFp).sort()) {
      for (const d of byFp[fp].decisions) {
        if (!d.task || d.outcomes.length) continue;
        const t = tasksById[d.task];
        if (!t || !require('./evaluate').isCompleted(t)) continue;
        pending.push(d.id);
      }
    }
    if (pending.length) {
      pending.sort();
      hints.push(
        `警告: 完了したタスクで下した決定 ${pending.length} 件の結果が未記録（${pending.join(', ')}）。` +
        '結果を照合しない決定は経験にならず、方針（推論なしで発火する直感）へ畳み込まれない。' +
        `node cli/index.js decision outcome ${pending[0]} --result met|unmet|unclear で答え合わせを`
      );
    }
  } catch {
    // 決定層が未整備でも主機能を止めない
  }

  for (const t of openTasksWithoutVerdicts(osDir)) {
    hints.push(
      `警告: ${t.id} の評価が未実行（未記録のevaluator: ${t.missing.join(', ')}）。` +
      `完了報告の前に node cli/index.js evaluate --task ${t.id} → next-action ${t.id} を実行すること`
    );
  }

  // goalの最終検証（F005）。期限（日付）ではなく事象で催促する: 前回のgoal監査以降に
  // 完了したタスクが3件を超えたら、goal憲章そのものの検証を促す。
  // 検証者は独立サブエージェント — ユーザーにしか検証できないのは未記録の意図だけである
  try {
    const audits = readJsonl(path.join(osDir, 'observations', 'goal_audit.jsonl'));
    const lastAudit = audits.length ? audits[audits.length - 1].ts : null;
    const doneSince = Object.values(require('./evaluate').loadTasks(osDir))
      .filter((t) => require('./evaluate').isCompleted(t) && (!lastAudit || t.ts > lastAudit)).length;
    if (doneSince >= 3) {
      hints.push(
        `ヒント: ${lastAudit ? '前回のgoal監査以降に' : 'goal監査が一度も無いまま'}タスクが${doneSince}件完了している。` +
        'node cli/index.js audit goal でbriefingを生成し、独立サブエージェントに憲章の照準を反証させよ'
      );
    }
  } catch {
    // ignore
  }

  for (const f of Object.values(loadFailures(osDir))) {
    if (TERMINAL.includes(f.state)) continue;
    const age = Math.floor((nowMs - Date.parse(f.reported_ts || f.ts)) / 86400000);
    if (age > staleDays) {
      hints.push(`警告: ${f.id} が${age}日滞留中（stale_after_days=${staleDays}超過）。このままではregressionが不合格になる。/investigate-failure で消化を`);
    } else if (age >= Math.ceil(staleDays * 0.7)) {
      hints.push(`ヒント: ${f.id} が${age}日未消化（あと${staleDays - age}日でregression不合格）。/investigate-failure の実行を検討`);
    }
  }
  return hints;
}

module.exports = { runRegression, maintenanceHints, openTasksWithoutVerdicts };
