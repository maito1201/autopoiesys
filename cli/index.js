#!/usr/bin/env node
'use strict';
// autopoiesys CLI — Skillが呼ぶ唯一の決定的入口。
// 形式は常に `node cli/index.js <cmd> [args] [--flag value]`。シェル構文は使わない。
const fs = require('node:fs');
const path = require('node:path');
const util = require('../core/util');
const store = require('../core/store');
const query = require('../core/query');
const evaluate = require('../core/evaluate');
const failure = require('../core/failure');
const schema = require('../core/schema');
const regression = require('../core/regression');
const metrics = require('../core/metrics');
const ingest = require('../core/ingest');
const scaffold = require('../core/scaffold');
const knowledge = require('../core/knowledge');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        addFlag(flags, a.slice(2, eq), a.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        addFlag(flags, a.slice(2), argv[++i]);
      } else {
        addFlag(flags, a.slice(2), true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function addFlag(flags, key, value) {
  if (key === 'param') {
    // --param k=v は複数指定可
    flags.params = flags.params || {};
    const eq = String(value).indexOf('=');
    if (eq < 0) throw new Error(`--param は k=v 形式: ${value}`);
    flags.params[String(value).slice(0, eq)] = String(value).slice(eq + 1);
    return;
  }
  flags[key] = value;
}

function requireOsDir(flags) {
  const osDir = flags['os-dir'] ? path.resolve(String(flags['os-dir'])) : util.findOsDir(process.cwd());
  if (!osDir || !fs.existsSync(path.join(osDir, 'config.yaml'))) {
    throw new Error('.os/ が見つからない。まず `node cli/index.js init` を実行する（または --os-dir で指定）');
  }
  return osDir;
}

function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(path.resolve(String(p)), 'utf8'));
}

// 主要コマンドのついでに運用ヒント（そろそろregression等）を1〜数行出す。
// ヒント生成の失敗は主機能を妨げない。
function printHints(osDir) {
  try {
    const hints = regression.maintenanceHints(osDir);
    if (hints.length) process.stdout.write('\n' + hints.join('\n') + '\n');
  } catch {
    // ignore
  }
}

function out(obj, flags) {
  if (flags.json) {
    process.stdout.write(util.stableStringify(obj, 2) + '\n');
    return;
  }
  process.stdout.write(human(obj) + '\n');
}

function human(obj, indent = '') {
  if (obj === null || obj === undefined) return indent + '(なし)';
  if (typeof obj !== 'object') return indent + String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return indent + '(0件)';
    return obj.map((v) => (typeof v === 'object' ? human(v, indent + '  ') : `${indent}- ${v}`)).join('\n');
  }
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object') {
      lines.push(`${indent}${k}:`);
      lines.push(human(v, indent + '  '));
    } else {
      lines.push(`${indent}${k}: ${v}`);
    }
  }
  return lines.join('\n');
}

const COMMANDS = {
  doctor(args) {
    const r = scaffold.doctor();
    out(r, args.flags);
    return r.ok ? 0 : 1;
  },

  init(args) {
    const dir = args.flags.dir ? path.resolve(String(args.flags.dir)) : process.cwd();
    const r = scaffold.initOs(dir, { force: !!args.flags.force });
    out({
      message: `.os/ を生成した: ${r.osDir}`,
      skill_stubs: `生成${r.skill_stubs.created.length}件 / 既存スキップ${r.skill_stubs.skipped.length}件（.claude/skills/）`,
      next: '新しいスタブはClaude Codeの次回セッション起動から有効。/init-os のヒアリングでgoal.yamlを埋め、autopoiesys validate で検証する',
    }, args.flags);
    return 0;
  },

  validate(args) {
    const osDir = requireOsDir(args.flags);
    const r = schema.validate(osDir);
    out(r, args.flags);
    return r.errors.length ? 1 : 0;
  },

  check(args) {
    const osDir = requireOsDir(args.flags);
    const r = schema.checkAll(osDir, { now: args.flags.now });
    out(r, args.flags);
    printHints(osDir);
    return r.errors.length || r.failure_lint.length ? 1 : 0;
  },

  rebuild(args) {
    const osDir = requireOsDir(args.flags);
    const snap = store.rebuildSnapshot(osDir);
    out({ statements: Object.keys(snap.statements).length, events: snap.meta.event_count }, args.flags);
    return 0;
  },

  assert(args) {
    const osDir = requireOsDir(args.flags);
    if (!args.flags.file) throw new Error('使い方: autopoiesys assert --file <statements.json>（単一オブジェクトまたは配列）');
    const data = readJsonFile(args.flags.file);
    const statements = Array.isArray(data) ? data : [data];
    const r = store.assertStatements(osDir, statements, { strict: !!args.flags.strict });
    out(r, args.flags);
    return 0;
  },

  // タスク中の学習還流。add: 新しい事実・制約を1件追記 / supersede: 既存Statementを訂正して置換 / show: 1件表示
  statement(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    const usage = '使い方: autopoiesys statement add "<body>" --type t --source s [--tags a,b] [--status fact|hypothesis|unknown] [--confidence 0.x] [--method llm|human|deterministic] [--task T001]\n' +
      '        autopoiesys statement supersede <S00xx> "<訂正後body>" --source s [--type/--tags/--status は省略時に旧Statementから継承]\n' +
      '        autopoiesys statement show <S00xx>';
    if (sub === 'show') {
      const id = args.positional[1];
      if (!id) throw new Error(usage);
      const snap = store.getSnapshot(osDir);
      const st = snap.statements[id];
      if (!st) throw new Error(`Statementが現在状態に存在しない: ${id}`);
      out(st, args.flags);
      return 0;
    }
    if (sub !== 'add' && sub !== 'supersede') throw new Error(usage);
    const supersedes = sub === 'supersede' ? args.positional[1] : undefined;
    const body = args.positional.slice(sub === 'supersede' ? 2 : 1).join(' ');
    if (!body || (sub === 'supersede' && !supersedes)) throw new Error(usage);
    if (!args.flags.source) throw new Error('--source が必要（何で裏取りしたか: ファイルパス、"本人指示 2026-08-27" 等）');
    const r = store.recordStatement(osDir, {
      body,
      supersedes,
      type: args.flags.type ? String(args.flags.type) : undefined,
      status: args.flags.status ? String(args.flags.status) : undefined,
      tags: args.flags.tags ? String(args.flags.tags).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      confidence: args.flags.confidence !== undefined ? Number(args.flags.confidence) : undefined,
      predicate: args.flags.predicate ? String(args.flags.predicate) : undefined,
      source: String(args.flags.source),
      method: args.flags.method ? String(args.flags.method) : undefined,
      task: args.flags.task ? String(args.flags.task) : undefined,
    });
    out(r, args.flags);
    return 0;
  },

  ingest(args) {
    const osDir = requireOsDir(args.flags);
    const what = args.positional[0] || 'repo';
    if (what !== 'repo') throw new Error(`未対応のingest対象: ${what}`);
    const repo = args.flags.repo ? path.resolve(String(args.flags.repo)) : process.cwd();
    const r = ingest.ingestRepo(osDir, repo);
    out(r, args.flags);
    return 0;
  },

  query(args) {
    const osDir = requireOsDir(args.flags);
    const name = args.positional[0];
    if (!name) {
      out({ queries: query.listQueries(osDir) }, args.flags);
      return 0;
    }
    const r = query.runQuery(osDir, name, args.flags.params || {}, {
      maxTokens: args.flags['max-tokens'] ? Number(args.flags['max-tokens']) : undefined,
      offset: args.flags.offset ? Number(args.flags.offset) : 0,
    });
    process.stdout.write(util.stableStringify(r, 1) + '\n');
    return 0;
  },

  task(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    if (sub === 'new') {
      const objective = args.positional.slice(1).join(' ');
      if (!objective) throw new Error('使い方: autopoiesys task new "<objective>" --evaluators a,b [--work-dir D] [--refs url1,url2] [--context "..."]');
      const evaluators = args.flags.evaluators ? String(args.flags.evaluators).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const t = evaluate.newTask(osDir, objective, evaluators, {
        work_dir: args.flags['work-dir'] ? path.resolve(String(args.flags['work-dir'])) : undefined,
        refs: args.flags.refs ? String(args.flags.refs).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        context: args.flags.context ? String(args.flags.context) : undefined,
      });
      out(t, args.flags);
      printHints(osDir);
      return 0;
    }
    if (sub === 'note') {
      const id = args.positional[1];
      const note = args.positional.slice(2).join(' ');
      if (!id || !note) throw new Error('使い方: autopoiesys task note <id> "<チェックポイント>"');
      // 全量再表示はトークンの無駄（全体は task show で見る）。追記の受理確認だけ返す
      const t = evaluate.addTaskNote(osDir, id, note);
      out({ task: t.id, notes: (t.notes || []).length, added: note }, args.flags);
      return 0;
    }
    if (sub === 'list') {
      out(Object.values(evaluate.loadTasks(osDir)), args.flags);
      return 0;
    }
    if (sub === 'show') {
      out(evaluate.getTask(osDir, args.positional[1]), args.flags);
      return 0;
    }
    if (sub === 'artifact') {
      const id = args.positional[1];
      if (!id || !args.flags.path) throw new Error('使い方: autopoiesys task artifact <id> --path <p> [--note <n>]');
      const t = evaluate.getTask(osDir, id);
      const artifacts = [...(t.artifacts || []), { path: String(args.flags.path), note: args.flags.note ? String(args.flags.note) : '' }];
      evaluate.updateTask(osDir, id, { artifacts });
      out({ task: id, artifacts: artifacts.length, added: String(args.flags.path) }, args.flags);
      return 0;
    }
    if (sub === 'set-evaluators') {
      const id = args.positional[1];
      const evaluators = String(args.flags.evaluators || '').split(',').map((s) => s.trim()).filter(Boolean);
      evaluate.updateTask(osDir, id, { evaluators });
      out({ task: id, evaluators }, args.flags);
      return 0;
    }
    throw new Error('使い方: autopoiesys task new|list|show|note|artifact|set-evaluators');
  },

  evaluate(args) {
    const osDir = requireOsDir(args.flags);
    const taskId = args.flags.task || args.positional[0];
    if (!taskId) throw new Error('使い方: autopoiesys evaluate --task <id> [--evaluator <id>] [--work-dir <dir>]');
    let replay;
    if (args.flags.replay) replay = readJsonFile(args.flags.replay);
    const r = evaluate.evaluateTask(osDir, String(taskId), {
      only: args.flags.evaluator ? String(args.flags.evaluator) : undefined,
      workDir: args.flags['work-dir'] ? path.resolve(String(args.flags['work-dir'])) : undefined,
      replay,
    });
    out(r.results, args.flags);
    const pending = r.results.filter((x) => x.pending);
    if (pending.length) {
      process.stdout.write(
        '\nllm_judge評価が保留中。独立サブエージェント（生成側の会話履歴を持たないこと）に\n' +
        '各briefingを読ませ、`node cli/index.js verdict --file <json>` で記録させること:\n' +
        pending.map((p) => `  ${p.briefing}`).join('\n') + '\n'
      );
    }
    printHints(osDir);
    return 0;
  },

  verdict(args) {
    const osDir = requireOsDir(args.flags);
    if (!args.flags.file) throw new Error('使い方: autopoiesys verdict --file <verdict.json>');
    const v = readJsonFile(args.flags.file);
    const r = evaluate.recordVerdict(osDir, v, { external: true });
    out(r, args.flags);
    return 0;
  },

  'next-action'(args) {
    const osDir = requireOsDir(args.flags);
    const taskId = args.positional[0] || args.flags.task;
    if (!taskId) throw new Error('使い方: autopoiesys next-action <taskId>');
    const r = evaluate.nextAction(osDir, String(taskId));
    out({ task: r.task, action: r.action, why: r.why, missing: r.missing }, args.flags);
    printHints(osDir);
    return 0;
  },

  feedback(args) {
    const osDir = requireOsDir(args.flags);
    const symptom = args.positional.join(' ');
    if (!symptom) throw new Error('使い方: autopoiesys feedback "<不満・症状>" [--task <id>] [--severity low|medium|high]');
    const r = failure.report(osDir, {
      symptom,
      severity: args.flags.severity ? String(args.flags.severity) : 'medium',
      task: args.flags.task ? String(args.flags.task) : undefined,
    });
    out(r.entry, args.flags);
    if (r.known_matches.length) {
      process.stdout.write('\n既知のFailureパターンに一致（cheap経路 — 既存Preventionの適用を検討）:\n' + human(r.known_matches) + '\n');
    } else {
      process.stdout.write('\n未知のfingerprint。investigate-failure Skill（T3許可）で調査を開始すること。\n');
    }
    printHints(osDir);
    return 0;
  },

  failure(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    if (sub === 'list') {
      const byId = failure.loadFailures(osDir);
      out(Object.values(byId).map((f) => ({ id: f.id, state: f.state, severity: f.severity, symptom: f.symptom })), args.flags);
      return 0;
    }
    if (sub === 'show') {
      const f = failure.loadFailures(osDir)[args.positional[1]];
      if (!f) throw new Error(`Failureが存在しない: ${args.positional[1]}`);
      out(f, args.flags);
      return 0;
    }
    if (sub === 'transition') {
      const id = args.positional[1];
      const to = args.flags.to;
      if (!id || !to) throw new Error('使い方: autopoiesys failure transition <id> --to <state> [--file <fields.json>]');
      const fields = args.flags.file ? readJsonFile(args.flags.file) : {};
      const r = failure.transition(osDir, String(id), String(to), fields);
      out(r, args.flags);
      return 0;
    }
    if (sub === 'lint') {
      const cfg = schema.loadConfig(osDir);
      const v = failure.lint(osDir, { staleAfterDays: cfg.stale_after_days || 7, now: args.flags.now });
      out(v, args.flags);
      return v.length ? 1 : 0;
    }
    throw new Error('使い方: autopoiesys failure list|show|transition|lint');
  },

  regression(args) {
    const osDir = requireOsDir(args.flags);
    const r = regression.runRegression(osDir, {
      repoRoot: args.flags.repo ? path.resolve(String(args.flags.repo)) : process.cwd(),
      now: args.flags.now,
    });
    out(r, args.flags);
    return r.pass ? 0 : 1;
  },

  research(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    if (sub === 'open') {
      const r = knowledge.researchOpen(osDir, args.flags.purpose ? String(args.flags.purpose) : args.positional.slice(1).join(' '));
      out(r, args.flags);
      return 0;
    }
    if (sub === 'close') {
      const assets = args.flags.assets ? String(args.flags.assets).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const cfg = schema.loadConfig(osDir);
      const budget = cfg.budgets && cfg.budgets.research_tokens;
      const r = knowledge.researchClose(osDir, args.positional[1], assets, { budget });
      out(r, args.flags);
      if (r.warning) process.stdout.write('\n' + r.warning + '\n');
      return 0;
    }
    if (sub === 'list') {
      out(Object.values(knowledge.loadResearchSessions(osDir)), args.flags);
      return 0;
    }
    throw new Error('使い方: autopoiesys research open --purpose "..." | close <id> --assets a,b | list');
  },

  ledger(args) {
    const osDir = requireOsDir(args.flags);
    if (args.positional[0] !== 'add') throw new Error('使い方: autopoiesys ledger add --purpose p --tier T2 --tokens-in N --tokens-out N [--task T001] [--model m] [--session R001] [--assets a,b]');
    const r = knowledge.ledgerAdd(osDir, {
      purpose: args.flags.purpose ? String(args.flags.purpose) : undefined,
      tier: String(args.flags.tier || ''),
      model: args.flags.model ? String(args.flags.model) : '',
      tokens_in: args.flags['tokens-in'],
      tokens_out: args.flags['tokens-out'],
      task: args.flags.task ? String(args.flags.task) : undefined,
      session: args.flags.session ? String(args.flags.session) : undefined,
      asset_refs: args.flags.assets ? String(args.flags.assets).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
    out(r, args.flags);
    return 0;
  },

  compile(args) {
    const osDir = requireOsDir(args.flags);
    if (!args.flags.file) throw new Error('使い方: autopoiesys compile --file <findings.json>');
    const r = knowledge.compileFindings(osDir, readJsonFile(args.flags.file));
    out(r, args.flags);
    return 0;
  },

  metrics(args) {
    const osDir = requireOsDir(args.flags);
    const r = metrics.computeMetrics(osDir);
    out(r, args.flags);
    return 0;
  },

  migrate(args) {
    const osDir = requireOsDir(args.flags);
    const cfg = schema.loadConfig(osDir);
    out({
      current_format: cfg.format_version,
      core_format: schema.FORMAT_VERSION,
      message: cfg.format_version === schema.FORMAT_VERSION
        ? '移行不要'
        : '形式が異なる。現時点で自動移行は未実装（format_version 0.xでは手動移行）',
    }, args.flags);
    return 0;
  },

  version(args) {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    out({ autopoiesys: pkg.version, format_version: schema.FORMAT_VERSION, node: process.versions.node }, args.flags);
    return 0;
  },

  help() {
    process.stdout.write(`autopoiesys — Intelligence OSの決定的コア

環境・初期化:   doctor / init [--dir D] [--force] / version / migrate
検証:           validate / check / rebuild
World Model:    assert --file s.json / statement add|supersede|show / ingest repo [--repo D] / query [name] [--param k=v]
タスクと評価:   task new|list|show|note|artifact / evaluate --task T / verdict --file v.json / next-action T
Failureループ:  feedback "..." / failure list|show|transition|lint / regression
Token Economics: ledger add / research open|close|list / compile --file f.json / metrics

全コマンド共通: [--os-dir D] [--json]
`);
    return 0;
  },
};

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return COMMANDS.help();
  }
  const handler = COMMANDS[cmd];
  if (!handler) {
    process.stderr.write(`未知のコマンド: ${cmd}（autopoiesys help 参照）\n`);
    return 2;
  }
  try {
    return handler(parseArgs(argv.slice(1)));
  } catch (e) {
    process.stderr.write(`エラー: ${e.message}\n`);
    return 1;
  }
}

process.exitCode = main();
