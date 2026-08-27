'use strict';
// goal.yaml / config.yaml / 各定義の検証と、.os/ 全体の整合検査（`autopoiesys check`）
const fs = require('node:fs');
const path = require('node:path');
const { parseYaml } = require('./yaml');
const { readTextFile } = require('./util');
const { lintWorldModel } = require('./store');
const { listQueries, loadQueryDef } = require('./query');
const { listEvaluators, loadEvaluatorDef, loadTasks } = require('./evaluate');
const failure = require('./failure');

const FORMAT_VERSION = '0.1.0';

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
  // 未完了タスクのevaluator参照（大文字小文字の不一致はLinux移送時に初めて壊れるため、ここで検出する）
  for (const t of Object.values(loadTasks(osDir))) {
    if (t.status === 'done') continue;
    for (const evId of t.evaluators || []) {
      if (!evs.includes(evId)) {
        report.errors.push(`tasks ${t.id}: 存在しないevaluator参照: ${evId}（大文字小文字も一致が必要）`);
      }
    }
  }
  const wm = lintWorldModel(osDir, { strict: !!cfg.strict_vocabulary });
  report.errors.push(...wm.errors);
  report.warnings.push(...wm.warnings);
  report.statement_count = wm.count;
  report.failure_lint = failure.lint(osDir, { staleAfterDays: cfg.stale_after_days || 7, now });
  return report;
}

module.exports = {
  FORMAT_VERSION,
  loadConfig,
  loadGoal,
  resolveSources,
  validateGoal,
  validateConfig,
  validateGoldenTask,
  listGoldenTasks,
  validate,
  checkAll,
  readYamlFile,
};
