'use strict';
// goal.yaml / config.yaml / 各定義の検証と、.os/ 全体の整合検査（`autopoiesys check`）
const fs = require('node:fs');
const path = require('node:path');
const { parseYaml } = require('./yaml');
const { readTextFile } = require('./util');
const { lintWorldModel } = require('./store');
const { listQueries, loadQueryDef, auditReachability } = require('./query');
const { discoverKnowledgeSources } = require('./ingest');
const { listEvaluators, loadEvaluatorDef, loadTasks } = require('./evaluate');
const failure = require('./failure');

const FORMAT_VERSION = '0.2.0'; // 0.2: Intelligence Graph（relationship第一級化・capability型・traverse・gap）— 追加的変更のみ

function readYamlFile(file) {
  if (!fs.existsSync(file)) return null;
  return parseYaml(readTextFile(file));
}

function loadConfig(osDir) {
  const cfg = readYamlFile(path.join(osDir, 'config.yaml'));
  if (!cfg) throw new Error(`config.yamlが存在しない: ${osDir}`);
  return cfg;
}

function loadGoal(osDir) {
  return readYamlFile(path.join(osDir, 'goal.yaml'));
}

// goal.yaml の sources を解決する。多リポジトリ横断が前提なので、各sourceは
// scope（World Model上の宛先名）で一意に識別される。scope省略時はパスのbasenameを使う。
// rule_docs / memory_dir は決定的取込（ingest rules / ingest memory）の入力。
function resolveSources(goal, osDir) {
  const workspace = path.dirname(path.resolve(osDir));
  const out = [];
  for (const src of (goal && goal.sources) || []) {
    if (!src || !src.repo) continue;
    const repo = path.resolve(workspace, String(src.repo));
    const scope = src.scope || path.basename(repo);
    out.push({
      scope,
      repo,
      rule_docs: src.rule_docs || [],
      memory_dir: src.memory_dir ? path.resolve(workspace, String(src.memory_dir)) : null,
    });
  }
  return out;
}

// goal.yaml の excluded_sources を解決する。「発見したが取り込まない」という判断を資産として
// 残すための宣言で、理由が必須。これが無いと「取りこぼし」と「意図した除外」が区別できない。
function resolveExcludedSources(goal, osDir) {
  const workspace = path.dirname(path.resolve(osDir));
  const out = [];
  for (const ex of (goal && goal.excluded_sources) || []) {
    if (!ex || !ex.path) continue;
    out.push({ path: path.resolve(workspace, String(ex.path)), reason: ex.reason ? String(ex.reason) : '' });
  }
  return out;
}

// goal.yaml検証。unbound（evaluator未接地）の基準一覧も返す。
function validateGoal(goal) {
  const errors = [];
  const unbound = [];
  if (!goal || typeof goal !== 'object') return { errors: ['goal.yamlが空か不正'], unbound };
  if (!goal.goal) errors.push('goal（自然文の目的）欠落');
  if (!goal.domain) errors.push('domain欠落');
  if (!Array.isArray(goal.objectives) || goal.objectives.length === 0) errors.push('objectivesは1件以上');
  for (const [listName, required] of [['success_criteria', true], ['constraints', false]]) {
    const list = goal[listName];
    if (!Array.isArray(list) || list.length === 0) {
      if (required) errors.push(`${listName}は1件以上`);
      continue;
    }
    for (const item of list) {
      if (!item || !item.id) {
        errors.push(`${listName}: 各項目にidが必要`);
        continue;
      }
      if (!item.statement) errors.push(`${listName} ${item.id}: statement欠落`);
      if (!item.evaluator) {
        errors.push(`${listName} ${item.id}: evaluator欠落（未実装なら unbound と書く）`);
      } else if (item.evaluator === 'unbound') {
        unbound.push({ list: listName, id: item.id, statement: item.statement });
      }
      if (listName === 'constraints' && item.severity && !['hard', 'soft'].includes(item.severity)) {
        errors.push(`constraints ${item.id}: severityはhard|soft`);
      }
    }
  }
  const seenScopes = new Set();
  for (const src of goal.sources || []) {
    if (!src || !src.repo) {
      errors.push('sources: 各項目にrepo（パス）が必要');
      continue;
    }
    const scope = src.scope || path.basename(path.resolve(String(src.repo)));
    if (seenScopes.has(scope)) errors.push(`sources: scopeが重複している: ${scope}`);
    seenScopes.add(scope);
  }
  for (const ex of goal.excluded_sources || []) {
    if (!ex || !ex.path) {
      errors.push('excluded_sources: 各項目にpath（除外する知識源のパス）が必要');
      continue;
    }
    // 理由なしの除外は「判断」ではなく取りこぼしの追認になるため必須にする
    if (!ex.reason) errors.push(`excluded_sources ${ex.path}: reason（なぜ取り込まないか）が必要`);
  }
  return { errors, unbound };
}

function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['config.yamlが空か不正'];
  if (!cfg.format_version) errors.push('format_version欠落');
  else if (String(cfg.format_version).split('.')[0] !== FORMAT_VERSION.split('.')[0]) {
    errors.push(`format_versionのメジャー不一致: ${cfg.format_version}（Core対応: ${FORMAT_VERSION}）— autopoiesys migrate を検討`);
  }
  if (!cfg.routing) errors.push('routing欠落');
  return errors;
}

function validateGoldenTask(gt) {
  const errors = [];
  if (!gt || typeof gt !== 'object') return ['golden taskが空か不正'];
  if (!gt.id) errors.push('id欠落');
  if (!gt.description) errors.push(`${gt.id || '?'}: description欠落`);
  if (!Array.isArray(gt.checks) || gt.checks.length === 0) {
    errors.push(`${gt.id || '?'}: checksは1件以上`);
    return errors;
  }
  for (const c of gt.checks) {
    if (!c || !c.evaluator) errors.push(`${gt.id}: 各checkにevaluatorが必要`);
    const expected = c && (c.expected || c.replay);
    if (!expected || !['PASS', 'FAIL', 'UNCERTAIN'].includes(expected)) {
      errors.push(`${gt.id}: 各checkにexpected（またはreplay）= PASS|FAIL|UNCERTAIN が必要`);
    }
  }
  return errors;
}

function listGoldenTasks(osDir) {
  const dir = path.join(osDir, 'golden_tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ file: path.join(dir, f), def: readYamlFile(path.join(dir, f)) }));
}

// validate: goal/configの検証とunbound一覧（Phase 1の可視化）
function validate(osDir) {
  const report = { errors: [], warnings: [], unbound: [] };
  const cfg = readYamlFile(path.join(osDir, 'config.yaml'));
  if (!cfg) report.errors.push('config.yamlが存在しない');
  else report.errors.push(...validateConfig(cfg));
  const goal = loadGoal(osDir);
  if (!goal) {
    report.warnings.push('goal.yamlが未作成（init-os Skillのヒアリングで生成する）');
  } else {
    const g = validateGoal(goal);
    report.errors.push(...g.errors);
    report.unbound = g.unbound;
  }
  return report;
}

// check: validate + 全定義 + World Model整合 + failure lint の総合検査
function checkAll(osDir, { now } = {}) {
  const report = validate(osDir);
  const cfg = fs.existsSync(path.join(osDir, 'config.yaml')) ? loadConfig(osDir) : {};
  for (const name of listQueries(osDir)) {
    try {
      loadQueryDef(osDir, name);
    } catch (e) {
      report.errors.push(e.message);
    }
  }
  for (const id of listEvaluators(osDir)) {
    try {
      loadEvaluatorDef(osDir, id);
    } catch (e) {
      report.errors.push(e.message);
    }
  }
  for (const { file, def } of listGoldenTasks(osDir)) {
    const errs = validateGoldenTask(def);
    report.errors.push(...errs.map((e) => `${path.basename(file)}: ${e}`));
    for (const c of (def && def.checks) || []) {
      if (c && c.evaluator && !listEvaluators(osDir).includes(c.evaluator)) {
        report.errors.push(`${path.basename(file)}: 存在しないevaluator参照: ${c.evaluator}`);
      }
    }
  }
  // goal.yamlのevaluator接地の実在確認
  const evs = listEvaluators(osDir);
  const goal = loadGoal(osDir);
  if (goal) {
    for (const listName of ['success_criteria', 'constraints']) {
      for (const item of goal[listName] || []) {
        if (item && item.evaluator && item.evaluator !== 'unbound' && !evs.includes(item.evaluator)) {
          report.errors.push(`goal.yaml ${listName} ${item.id}: 存在しないevaluator参照: ${item.evaluator}`);
        }
      }
    }
  }
  // 成功基準は「規定への適合（conformance）」だけでは接地しない。適合を全通過しても
  // 目的未達でありうるため、outcome型の判定器が1つも無い成功基準を警告する。
  if (goal) {
    const unbackedByOutcome = [];
    for (const item of goal.success_criteria || []) {
      if (!item || !item.id) continue;
      if (!item.evaluator || item.evaluator === 'unbound' || !evs.includes(item.evaluator)) continue;
      let def;
      try {
        def = loadEvaluatorDef(osDir, item.evaluator);
      } catch {
        continue; // 定義エラーは上のループで報告済み
      }
      if (def.kind !== 'outcome') unbackedByOutcome.push(`${item.id}→${item.evaluator}`);
    }
    if (unbackedByOutcome.length) {
      report.warnings.push(
        `outcome型の判定器で裏付けられていない成功基準が${unbackedByOutcome.length}件（${unbackedByOutcome.join(', ')}）` +
        '— evaluatorに kind: conformance | outcome を宣言し、各success_criteriaに最低1つのoutcomeを束縛せよ'
      );
    }
  }
  // 未完了タスクのevaluator参照（大文字小文字の不一致はLinux移送時に初めて壊れるため、ここで検出する）
  for (const t of Object.values(loadTasks(osDir))) {
    if (require('./evaluate').isCompleted(t)) continue;
    for (const evId of t.evaluators || []) {
      if (!evs.includes(evId)) {
        report.errors.push(`tasks ${t.id}: 存在しないevaluator参照: ${evId}（大文字小文字も一致が必要）`);
      }
    }
  }
  // 知識パイプラインの監査（①知識源の発見・⑤Queryからの到達）。取りこぼしと引けない事実は
  // 放置すると静かに「無かったこと」になるため、毎回のcheckで可視化する（詳細は sources scan /
  // audit reachability）。checkの合否は既存の契約（errors / failure_lint）を変えない。
  if (goal) {
    const disc = discoverKnowledgeSources({
      sources: resolveSources(goal, osDir),
      excluded: resolveExcludedSources(goal, osDir),
    });
    if (disc.undecided.length) {
      report.warnings.push(
        `未決定の知識源が${disc.undecided.length}件（例: ${disc.undecided.slice(0, 3).map((c) => c.path).join(', ')}）` +
        '— sources scan で全件確認し、sourcesへ登録するか excluded_sources に理由付きで除外を宣言せよ'
      );
    }
  }
  const reach = auditReachability(osDir);
  if (reach.unreachable.length) {
    report.warnings.push(
      `どのQueryからも引けないStatementが${reach.unreachable.length}件（例: ${reach.unreachable.slice(0, 5).join(', ')}）` +
      '— 引けない事実は運用上存在しない。audit reachability で確認せよ'
    );
  }
  if (reach.truncating.length) {
    report.warnings.push(
      `一致件数が返却枠を超えるQueryが${reach.truncating.length}パターン` +
      `（対象: ${[...new Set(reach.truncating.map((t) => t.query))].join(', ')}）` +
      '— 呼び出し側がnext_offsetで追わないと最後尾が落ちる'
    );
  }
  // Coreが後から同梱したQueryが、この .os に届いているか。
  // init は writeIfAbsent 方式なので、**既にある .os には新しい同梱ファイルが永久に入らない**。
  // 実例: get_past_decisions の欠落に、decision を1件記録して wm_reachability が
  // 落ちるまで誰も気づけなかった。到達性のFAILは、たいてい「Queryが足りない」ではなく
  // 「Coreの更新が届いていない」を意味する。
  // requireを関数内に置いているのは循環参照の回避（scaffoldはFORMAT_VERSIONのために
  // このモジュールをトップレベルでrequireしている）。
  const missingBundled = require('./scaffold').missingBundledQueries(osDir);
  if (missingBundled.length) {
    report.warnings.push(
      `Coreが同梱するQueryが${missingBundled.length}件この.osに無い（${missingBundled.join(', ')}）` +
      '— Core更新が既存の.osに届いていない。autopoiesys init --force で不足分だけ補える（既存ファイルは上書きしない）'
    );
  }
  const wm = lintWorldModel(osDir, { strict: !!cfg.strict_vocabulary });
  report.errors.push(...wm.errors);
  report.warnings.push(...wm.warnings);
  report.statement_count = wm.count;
  // 宣言台帳の整合。壊れた参照を黙って落とすと「読めなかった」が「無かった」に化ける
  const cl = require('./claims').lintClaims(osDir);
  report.errors.push(...cl.errors);
  report.claim_count = cl.count;
  report.failure_lint = failure.lint(osDir, { staleAfterDays: cfg.stale_after_days || 7, now });
  return report;
}

module.exports = {
  FORMAT_VERSION,
  loadConfig,
  loadGoal,
  resolveSources,
  resolveExcludedSources,
  validateGoal,
  validateConfig,
  validateGoldenTask,
  listGoldenTasks,
  validate,
  checkAll,
  readYamlFile,
};
