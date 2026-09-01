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
const gap = require('../core/gap');
const decision = require('../core/decision');
const policy = require('../core/policy');
const routing = require('../core/routing');
const plan = require('../core/plan');
const taskclass = require('../core/taskclass');
const experience = require('../core/experience');
const growth = require('../core/growth');
const agendaMod = require('../core/agenda');
const claimaudit = require('../core/claimaudit');
const contextMod = require('../core/context');
const claims = require('../core/claims');

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

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {
    return `(読めない: ${e.message})`;
  }
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
      skills: `生成${r.skill_stubs.created.length}件 / 更新${r.skill_stubs.updated.length}件 / ユーザー改変につきスキップ${r.skill_stubs.skipped.length}件（.claude/skills/）`,
      next: '新しいスキルはClaude Codeの次回セッション起動から有効。/init-os のヒアリングでgoal.yamlを埋め、autopoiesys validate で検証する',
    }, args.flags);
    return 0;
  },

  // .claude/skills/ は skills/ の生成物。--check は正本とのズレを検出して非ゼロで落ちる
  skills(args) {
    if (args.positional[0] !== 'sync') throw new Error('使い方: autopoiesys skills sync [--dir D] [--check]');
    const dir = args.flags.dir ? path.resolve(String(args.flags.dir)) : process.cwd();
    const check = args.flags.check === true;
    const r = scaffold.syncSkills(dir, { check });
    out({
      mode: check ? 'check' : 'sync',
      created: r.created,
      updated: r.updated,
      unchanged: r.unchanged.length,
      skipped_user_modified: r.skipped,
      stale: r.stale,
    }, args.flags);
    if (check && r.stale.length) {
      process.stderr.write(`正本とズレたスキルが${r.stale.length}件: ${r.stale.join(', ')}（autopoiesys skills sync で再生成する）\n`);
      return 1;
    }
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
    const usage = '使い方: autopoiesys statement add "<body>" --type t --source s [--tags a,b] [--scope repo1,repo2] [--status fact|hypothesis|unknown] [--confidence 0.x] [--method llm|human|deterministic] [--task T001]\n' +
      '        （--type unknown のときだけ [--blocks <塞いでいる判断・基準のID列>] [--importance 0..1]）\n' +
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
      scope: args.flags.scope ? String(args.flags.scope).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      confidence: args.flags.confidence !== undefined ? Number(args.flags.confidence) : undefined,
      predicate: args.flags.predicate ? String(args.flags.predicate) : undefined,
      // type: unknown 専用。「分からない」を散文で終わらせず、
      // 何の判断を塞いでいるか・どれだけ効くかで並べ替えられるようにする
      blocks: args.flags.blocks ? String(args.flags.blocks).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      importance: args.flags.importance !== undefined ? Number(args.flags.importance) : undefined,
      // type: lesson 専用。適用条件とタスク類型が、再来時の自動想起の鍵になる
      when: args.flags.when ? String(args.flags.when) : undefined,
      task_class: args.flags['task-class'] ? String(args.flags['task-class']) : undefined,
      source: String(args.flags.source),
      method: args.flags.method ? String(args.flags.method) : undefined,
      task: args.flags.task ? String(args.flags.task) : undefined,
    });
    out(r, args.flags);
    return 0;
  },

  // 第一級Relationの起票（type:relationship Statementの糖衣。CONCEPTv2 §4）
  relate(args) {
    const osDir = requireOsDir(args.flags);
    const [subject, predicate, object] = args.positional;
    const body = args.positional.slice(3).join(' ');
    if (!subject || !predicate || !object || !body) {
      throw new Error(
        '使い方: autopoiesys relate <subject> <predicate> <object> "<説明>" --source s\n' +
        '  [--confidence 0.x] [--status fact|hypothesis] [--conditions a,b] [--exceptions a,b] [--task T001]\n' +
        '  端点はStatementIDまたは evaluator:|query:|golden_task:|task:|failure:|skill: の型付き参照'
      );
    }
    if (!args.flags.source) throw new Error('--source が必要（この関係を何で裏取りしたか）');
    const r = store.recordStatement(osDir, {
      type: 'relationship',
      body,
      subject: String(subject),
      predicate: String(predicate),
      object: String(object),
      status: args.flags.status ? String(args.flags.status) : undefined,
      confidence: args.flags.confidence !== undefined ? Number(args.flags.confidence) : undefined,
      conditions: args.flags.conditions ? String(args.flags.conditions).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      exceptions: args.flags.exceptions ? String(args.flags.exceptions).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      source: String(args.flags.source),
      method: args.flags.method ? String(args.flags.method) : undefined,
      task: args.flags.task ? String(args.flags.task) : undefined,
    });
    out(r, args.flags);
    return 0;
  },

  // Intelligence Gap Analysis（CONCEPTv2 §6）。保存せず毎回再計算する
  gap(args) {
    const osDir = requireOsDir(args.flags);
    const cfg = schema.loadConfig(osDir);
    const analysis = gap.gapAnalysis(osDir, {
      goalId: args.flags.goal ? String(args.flags.goal) : undefined,
      floor: args.flags.floor !== undefined ? Number(args.flags.floor)
        : (cfg.gap_confidence_floor !== undefined ? Number(cfg.gap_confidence_floor) : undefined),
      staleAfterDays: cfg.stale_after_days || 7,
      now: args.flags.now,
      criteriaOnly: !!args.flags['criteria-only'],
    });
    out(analysis, args.flags);
    if (args.flags.assert) {
      const r = gap.assertMissingAsUnknowns(osDir, analysis);
      process.stdout.write(`\nMISSINGをUnknownとして起票: 追加${r.added.length}件 / 既存${r.skipped.length}件\n`);
    }
    printHints(osDir);
    return 0;
  },

  // 決定的取込（LLMゼロ）。repo=構成とgit観測 / rules=作業規約ドキュメント / memory=自動メモリ索引。
  // 対象は goal.yaml の sources（scopeで識別）から解決する。--scope 省略時は全source。
  ingest(args) {
    const osDir = requireOsDir(args.flags);
    const what = args.positional[0] || 'repo';
    // knowledge = 外部知識源（rules + memory）。repoはgit状態を観測するため常に変化しうるので、
    // 同期状態の検査（--check）はknowledgeに対して行う
    const KIND_SETS = { all: ['repo', 'rules', 'memory'], knowledge: ['rules', 'memory'] };
    const kinds = KIND_SETS[what] || [what];
    const dryRun = !!args.flags.check;
    for (const k of kinds) {
      if (!['repo', 'rules', 'memory'].includes(k)) {
        throw new Error(`未対応のingest対象: ${k}（repo | rules | memory | all）`);
      }
    }
    const sources = schema.resolveSources(schema.loadGoal(osDir), osDir);
    let targets;
    if (args.flags.repo) {
      // 明示パス指定はsources未登録のリポジトリを一度だけ観測する用途。scopeは明示が必要
      const repo = path.resolve(String(args.flags.repo));
      targets = [{ scope: args.flags.scope ? String(args.flags.scope) : path.basename(repo), repo, rule_docs: [], memory_dir: null }];
    } else if (args.flags.scope) {
      const wanted = String(args.flags.scope).split(',').map((v) => v.trim()).filter(Boolean);
      targets = sources.filter((sc) => wanted.includes(sc.scope));
      const missing = wanted.filter((w) => !sources.some((sc) => sc.scope === w));
      if (missing.length) throw new Error(`goal.yaml sources に無いscope: ${missing.join(', ')}（登録済み: ${sources.map((s) => s.scope).join(', ') || 'なし'}）`);
    } else {
      targets = sources;
      if (!targets.length) {
        // sources未定義のOSでは従来どおりカレントディレクトリを観測する
        targets = [{ scope: path.basename(process.cwd()), repo: process.cwd(), rule_docs: [], memory_dir: null }];
      }
    }
    const results = [];
    for (const t of targets) {
      for (const k of kinds) {
        if (k === 'repo') {
          results.push({ scope: t.scope, kind: 'repo', ...ingest.ingestRepo(osDir, t.repo, { scope: t.scope, dryRun }) });
        } else if (k === 'rules') {
          if (!t.rule_docs.length) continue;
          results.push({ scope: t.scope, kind: 'rules', ...ingest.ingestRuleDocs(osDir, { scope: t.scope, repoRoot: t.repo, docs: t.rule_docs, dryRun }) });
        } else if (k === 'memory') {
          if (!t.memory_dir) continue;
          results.push({ scope: t.scope, kind: 'memory', ...ingest.ingestMemoryIndex(osDir, { scope: t.scope, dir: t.memory_dir, dryRun }) });
        }
      }
    }
    if (!results.length) {
      throw new Error(`取込対象がない（${kinds.join('/')} の入力が goal.yaml sources に定義されていない）`);
    }
    if (dryRun) {
      // 未取込・更新済み未反映がある＝知識源とWorld Modelが同期していない。exit 1で検出可能にする
      const stale = results.filter((r) => (r.would_add || []).length);
      const missing = results.filter((r) => (r.missing_docs || []).length);
      const pending = stale.reduce((n, r) => n + r.would_add.length, 0);
      out({
        check: true,
        pending_total: pending,
        out_of_sync: stale.map((r) => ({ scope: r.scope, kind: r.kind, would_add: r.would_add.length })),
        missing_docs: missing.map((r) => ({ scope: r.scope, docs: r.missing_docs })),
        message: pending || missing.length
          ? `知識源がWorld Modelに反映されていない（未取込/更新 ${pending}件）。autopoiesys ingest ${what} を実行せよ`
          : '同期済み',
      }, args.flags);
      return pending || missing.length ? 1 : 0;
    }
    const added = results.reduce((n, r) => n + r.added.length, 0);
    out({ added_total: added, results }, args.flags);
    return 0;
  },

  // 知識源の発見（①）。sources/excluded_sources と突き合わせ、未決定の候補が残っていれば exit 1。
  // 「取りこぼしたのか、意図して外したのか」を人の記憶ではなく宣言で判別できる状態を保つ。
  sources(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0] || 'scan';
    if (sub !== 'scan') throw new Error('使い方: autopoiesys sources scan [--emit]');
    const goal = schema.loadGoal(osDir);
    let sources = schema.resolveSources(goal, osDir);
    if (!sources.length) {
      // sources未定義のOS（init直後）でもワークスペースは走査する。発見はgoal確定の前に必要
      const workspace = path.dirname(path.resolve(osDir));
      sources = [{ scope: path.basename(workspace), repo: workspace, rule_docs: [], memory_dir: null }];
    }
    const d = ingest.discoverKnowledgeSources({
      sources,
      excluded: schema.resolveExcludedSources(goal, osDir),
    });
    const byDecision = (v) => d.candidates.filter((c) => c.decision === v);
    out({
      registered: byDecision('registered').map((c) => c.path),
      excluded: byDecision('excluded').map((c) => `${c.path}（${c.reason}）`),
      undecided: d.undecided.map((c) => (c.kind === 'memory_dir' ? `${c.path}（${c.files}件）` : c.path)),
      doc_clusters: d.doc_clusters.map((c) => `${c.scope}: ${c.dir} (${c.files}件)`),
      warnings: d.warnings,
      message: d.undecided.length
        ? `未決定の知識源が${d.undecided.length}件ある。goal.yaml の sources に登録するか、excluded_sources に理由付きで除外を宣言せよ`
        : '知識源はすべて登録済みか除外宣言済み',
      hint: 'doc_clusters はファイル名から正本性を判定できない領域固有ドキュメントの在処。正本があるかを人に聞くこと',
    }, args.flags);
    if (args.flags.emit && d.undecided.length) process.stdout.write(`\n${ingest.emitSourcesDraft(d)}\n`);
    return d.undecided.length ? 1 : 0;
  },

  // 到達性監査（⑤）。取り込んだ知識がQueryの返却枠に実際に入るかを決定的に検査する。
  audit(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0] || 'reachability';
    // goalの最終検証（F005由来・ユーザー指示）: goal憲章そのものを、生成側の会話履歴を
    // 持たない独立サブエージェントに敵対的に検証させる。評価器がobjectiveを見るのに対し、
    // これはgoal.yaml自体が「記録された意図」をencodeしているかを見る — 検証スタックの最上層。
    // ユーザーにしか検証できないのは、まだどこにも記録されていない意図だけである
    if (sub === 'goal') {
      const logFile = path.join(osDir, 'observations', 'goal_audit.jsonl');
      if (args.flags['verdict-file']) {
        const v = readJsonFile(args.flags['verdict-file']);
        const errs = [];
        if (!['PASS', 'FAIL', 'UNCERTAIN'].includes(v.verdict)) errs.push('verdictは PASS|FAIL|UNCERTAIN');
        if (!Array.isArray(v.evidence) || !v.evidence.length) errs.push('evidenceは1件以上必須');
        if (errs.length) throw new Error(`goal監査verdict検証エラー:\n  ${errs.join('\n  ')}`);
        const entry = { ts: util.nowIso(), verdict: v.verdict, evidence: v.evidence, rationale: v.rationale || '', briefing: v.briefing || '' };
        util.appendJsonl(logFile, entry);
        out(entry, args.flags);
        if (v.verdict === 'FAIL') {
          process.stdout.write('\n警告: goal憲章が記録された意図とずれている。ログで終わらせずFailureとして起票し、goal.yamlを直すこと\n');
        }
        return 0;
      }
      const lines = ['# goal監査依頼: goal憲章は記録された意図をencodeしているか', ''];
      lines.push('あなたは独立監査者である。生成エージェントの会話履歴・自己申告は参照せず、');
      lines.push('このbriefingの内容だけを根拠に、**反証を探す姿勢で**判定せよ。');
      lines.push('');
      lines.push('## 検証する問い');
      lines.push('1. goal.yamlのgoal文は、下の「記録された意図」と矛盾・欠落なく整合しているか');
      lines.push('2. success_criteriaはgoalそのものを測っているか。それとも測定可能な代理');
      lines.push('   （例:「改善している」を「系列が存在する」に置換）へすり替わっていないか');
      lines.push('3. goalの一部が、どの基準にも紐づかず黙って落ちていないか');
      lines.push('');
      lines.push('## goal.yaml（現物）');
      lines.push('```yaml');
      lines.push(readTextSafe(path.join(osDir, 'goal.yaml')));
      lines.push('```');
      lines.push('## 記録された意図・制約（World Modelより。memory由来を含む）');
      for (const q of ['get_knowledge', 'get_repo_playbook']) {
        try {
          const res = query.runQuery(osDir, q, {});
          for (const row of res.results || []) lines.push(`- [${row.id}] ${row.body}`);
        } catch (e) {
          lines.push(`(Query ${q} 実行エラー: ${e.message})`);
        }
      }
      lines.push('');
      lines.push('## 未消化のFailure（意図とのずれの兆候）');
      const failures = Object.values(failure.loadFailures(osDir))
        .filter((f) => !['implemented', 'accepted_risk'].includes(f.state));
      lines.push(failures.length
        ? failures.map((f) => `- ${f.id}(${f.state}): ${f.symptom}`).join('\n')
        : '(なし)');
      lines.push('');
      lines.push('## 出力方法');
      lines.push('判定JSON（verdict: PASS|FAIL|UNCERTAIN, evidence: [根拠。goal.yamlの行と意図IDの対応で], rationale）を');
      lines.push('一時ファイルに書き、次で記録せよ:');
      lines.push('');
      lines.push('    node cli/index.js audit goal --verdict-file <判定JSONのパス>');
      lines.push('');
      const seq = util.readJsonl(logFile).length + 1;
      const file = path.join(osDir, 'briefings', `goal-audit-${String(seq).padStart(3, '0')}.md`);
      fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
      out({ briefing: file, message: '独立サブエージェント（生成側の会話履歴を持たないこと）にこのbriefingだけを渡し、判定を記録させよ' }, args.flags);
      return 0;
    }
    if (sub !== 'reachability') throw new Error('使い方: autopoiesys audit reachability|goal [--verdict-file <json>]');
    const r = query.auditReachability(osDir);
    out({
      statement_count: r.statement_count,
      query_count: r.query_count,
      reached: r.reached,
      unreachable: r.unreachable,
      truncating: r.truncating.map((t) => `${t.query} ${JSON.stringify(t.params)}: 一致${t.total}件中${t.count}件`),
      defects: r.defects,
      message: r.violations
        ? [
          r.unreachable.length
            ? `Queryから引けない事実が${r.unreachable.length}件ある（引けない事実は運用上存在しない）。Queryの絞り込み軸・limitを見直すか、Statementのタグ/scopeを直せ`
            : '',
          r.defects.length ? `監査できないQueryが${r.defects.length}件ある（defects参照）` : '',
        ].filter(Boolean).join(' / ')
        : '全Statementが少なくとも1本のQueryから到達可能',
    }, args.flags);
    return r.violations ? 1 : 0;
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

  // 実行側にも最小Subgraphを配る（CONCEPTv2 §8「Agentにはこのsubgraphだけを渡す」）。
  // これまで Reasoning Context は llm_judge の briefing にしか流れておらず、
  // 仕事をするAgent（特に会話履歴を持たないサブエージェント）には、
  // 「会話の切り貼り」以外に文脈を渡す手段が無かった。
  context(args) {
    const osDir = requireOsDir(args.flags);
    const purpose = args.flags.purpose ? String(args.flags.purpose) : args.positional.join(' ');
    const taskId = args.flags.task ? String(args.flags.task) : null;
    if (!purpose && !taskId) {
      throw new Error('使い方: autopoiesys context [--task T] [--purpose "<これから何をするか>"] [--queries q1,q2] [--max-tokens N] [--param k=v]');
    }
    const r = contextMod.deliverContext(osDir, {
      task: taskId ? evaluate.getTask(osDir, taskId) : null,
      purpose,
      queries: args.flags.queries ? String(args.flags.queries).split(',').map((v) => v.trim()) : [],
      maxTokens: args.flags['max-tokens'] ? Number(args.flags['max-tokens']) : undefined,
      params: args.flags.params || {},
    });
    if (args.flags.json) {
      out(r, args.flags);
      return 0;
    }
    process.stdout.write(r.lines.join('\n') + '\n');
    return 0;
  },

  task(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    if (sub === 'new') {
      const objective = args.positional.slice(1).join(' ');
      if (!objective) throw new Error('使い方: autopoiesys task new "<objective>" --evaluators a,b [--verbatim "<ユーザー依頼の原文>"] [--repos <scope>[=<dir>],...] [--origin <agenda:ref|failure:F00x|lesson:S00xx|unknown:S00xx|user>] [--class \"...\"] [--work-dir D] [--refs url1,url2] [--context "..."]');
      const evaluators = args.flags.evaluators ? String(args.flags.evaluators).split(',').map((s) => s.trim()).filter(Boolean) : [];
      // --repos: 横断タスクが触るリポジトリ。scope→作業ディレクトリの対応を作る。
      // =dir を省略した場合は goal.yaml sources のrepoを使う（worktreeで作業する場合は明示する）
      const repoDirs = {};
      if (args.flags.repos) {
        const sources = schema.resolveSources(schema.loadGoal(osDir), osDir);
        for (const spec of String(args.flags.repos).split(',').map((v) => v.trim()).filter(Boolean)) {
          const eq = spec.indexOf('=');
          const scope = eq === -1 ? spec : spec.slice(0, eq);
          if (eq !== -1) {
            repoDirs[scope] = path.resolve(spec.slice(eq + 1));
            continue;
          }
          const src = sources.find((sc) => sc.scope === scope);
          if (!src) {
            throw new Error(`goal.yaml sources に無いscope: ${scope}（ディレクトリを明示するなら ${scope}=<dir> と書く）`);
          }
          repoDirs[scope] = src.repo;
        }
      }
      const t = evaluate.newTask(osDir, objective, evaluators, {
        repo_dirs: repoDirs,
        work_dir: args.flags['work-dir'] ? path.resolve(String(args.flags['work-dir'])) : undefined,
        refs: args.flags.refs ? String(args.flags.refs).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        context: args.flags.context ? String(args.flags.context) : undefined,
        class: args.flags.class ? String(args.flags.class) : undefined,
        origin: args.flags.origin ? String(args.flags.origin) : undefined,
        verbatim: args.flags.verbatim ? String(args.flags.verbatim) : undefined,
      });
      out(t, args.flags);
      // 原文接地の開示。意図の曲解は言い換え（objective化）の瞬間に起きるので、
      // ユーザー由来のタスクに原文が無いことは、その場で告げる（強制はしない）
      if (!t.verbatim && (!t.origin || t.origin === 'user')) {
        process.stdout.write('\nヒント: ユーザー依頼の原文が未登録。--verbatim "<原文>" で焼き込むと、目的適合の判定が実行者の言い換えではなく原文に接地する\n');
      }
      // 由来の開示（F005 A-3）。内容は強制しない — 無いことだけを告げる。
      // これが無いと「agendaが駆動した仕事」が機械記録にならず、指示なし推進（C4）が
      // 永久に照合不能のままになる
      if (!t.origin) {
        process.stdout.write('\nヒント: このタスクの由来が未記録。--origin <agenda:項目 | failure:F00x | lesson:S00xx | unknown:S00xx | user> で、何がこの仕事を要求したかを開示せよ\n');
      } else if (t.origin_verified) {
        // 解決できた由来だけが自発的推進（sc-007）の証拠になる。解決の事実をその場で見せる
        process.stdout.write(`\nOS由来として解決した: ${t.origin_verified.ref}（${t.origin_verified.via}）\n`);
      }
      // 判定器の弱体化を、選び終えたその場で押し出す（F014）。
      // 完了認定は「宣言されたevaluatorが全てPASS」なので、宣言集合が弱ければ
      // 完全な合格が目的未達と両立する。実測: 目的適合を見る唯一の層が5タスク連続で
      // 落ちたまま通り、評価器の件数は増えていたので量的な監視では見えなかった。
      // 出すのは事実だけで、宣言は強制しない
      try {
        const drift = taskclass.evaluatorDrift(osDir, {
          classFp: t.class_fp,
          evaluators: t.evaluators,
          excludeTaskId: t.id,
        });
        if (drift.length) {
          process.stdout.write(
            '\n警告: 同じ類型の過去タスクが判定させていた評価器が、今回は宣言されていない:\n'
            + drift.map((d) => `  - ${d.evaluator}（過去: ${d.tasks.join(', ')}）`).join('\n')
            + '\n意図して外したなら task note に理由を残すこと。'
            + '判定させない選択は、完了認定の意味を静かに変える\n'
          );
        }
      } catch (e) {
        process.stdout.write(`\n（判定器の推移の照合に失敗: ${e.message}）\n`);
      }
      // 想起は押し付ける。自分が何を思い出せていないかは自分では分からないので、
      // 「必要なら聞く」に任せると一番必要なときに一番落ちる
      try {
        if (t.class_fp) {
          const d = experience.digest(osDir, t);
          process.stdout.write('\n' + d.lines.join('\n') + '\n');
          // 想起の配信を機械記録する。これが無いと「教訓が届いた」ことの証拠が
          // 実行者の記憶にしか無く、経験再利用の検証が原理的に閉じない（T009監査）
          experience.logDigest(osDir, t.id, d);
        } else {
          // 類型なし = 一回きり宣言。ただし実は再来だった場合に気づける材料は出す
          const sug = taskclass.suggestClasses(osDir, objective).slice(0, 3);
          if (sug.length) {
            process.stdout.write('\nヒント: 既存の類型に近い（実は再来なら --class を付け直すこと）:\n'
              + sug.map((s) => `  - ${s.class}（過去: ${s.tasks.join(', ')}）`).join('\n') + '\n');
          }
        }
      } catch (e) {
        process.stdout.write(`\n（想起の組み立てに失敗: ${e.message}）\n`);
      }
      // 較正実績の注入（持続する自己）。宣言が実行を生き延びた記録は、セッションを
      // 跨いで蓄積され、毎回ここで実行者の文脈に返る — 実績が裁量（監査率）を決める
      try {
        const cal = claims.calibrationLines(osDir, { classFp: t.class_fp || undefined });
        if (cal.length) process.stdout.write('\n' + cal.join('\n') + '\n');
      } catch {
        // 較正台帳が未整備でもtask newを止めない
      }
      printHints(osDir);
      return 0;
    }
    // 想起の束を取り直す（コンパクション・プロセス交代後の再開用）
    if (sub === 'brief') {
      const id = args.positional[1];
      if (!id) throw new Error('使い方: autopoiesys task brief <id>');
      const t = evaluate.getTask(osDir, id);
      const d = experience.digest(osDir, t);
      process.stdout.write(d.lines.join('\n') + '\n');
      experience.logDigest(osDir, id, d);
      return 0;
    }
    // 蒸留。強制されるのは開示であって内容ではない（--none-learned で「学びなし」も通る）
    if (sub === 'consolidate') {
      const id = args.positional[1];
      if (!id) throw new Error('使い方: autopoiesys task consolidate <id> --lessons <S00x,...> [--helped <S00a,...>] [--misled <S00b,...>] [--unapplied <S00c,...> --unapplied-reason "<理由>"] [--none-learned "<理由>"] [--note "<補足>"]');
      const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
      const helped = list(args.flags.helped);
      const misled = list(args.flags.misled);
      // unapplied = 配信され適用場面もあったが適用しなかった（F009）。教訓に極性は張らない
      const unapplied = list(args.flags.unapplied);
      // 台帳に「効いた/外れた」と書くなら、evidenceの書き戻しも必ず伴わせる。
      // 記録だけ書いてフィードバックを書かない経路を残すと、教訓の実績数が嘘になる
      const r = taskclass.recordConsolidation(osDir, id, {
        lessons: list(args.flags.lessons),
        helped,
        misled,
        unapplied,
        unapplied_reason: args.flags['unapplied-reason'] ? String(args.flags['unapplied-reason']) : undefined,
        none_learned: args.flags['none-learned'] ? String(args.flags['none-learned']) : undefined,
        note: args.flags.note ? String(args.flags.note) : undefined,
      });
      let fb = null;
      if (helped.length || misled.length) {
        fb = experience.feedback(osDir, { helped, misled, task: id, source: 'task-consolidate' });
      }
      out({ task: id, consolidated: r.consolidated || r, feedback: fb ? fb.added : [] }, args.flags);
      // 蒸留の被覆検査（F005 A-4）: 配信された教訓に処遇（helped/misled）が無いものを告げる。
      // 自己申告の真偽は検証できないが、**無申告は機械検出できる** — 「届いたが黙って
      // 無視された」を可視化する。処遇の強制ではない（無視してよいが、無言では通さない）
      try {
        const delivered = new Set();
        for (const c of util.readJsonl(path.join(osDir, 'observations', 'context_log.jsonl'))) {
          if (c.kind === 'digest' && c.task === id) for (const l of c.lessons || []) delivered.add(l);
        }
        const disposed = new Set([...helped, ...misled, ...unapplied]);
        const silent = [...delivered].filter((l) => !disposed.has(l)).sort();
        if (silent.length) {
          process.stdout.write(
            `\nヒント: 配信されたのに処遇の無い教訓が${silent.length}件（${silent.join(', ')}）。` +
            '効いたなら --helped、外れたなら --misled、使わなかったなら--noteに理由を残すこと\n'
          );
        }
      } catch {
        // 被覆検査の失敗で蒸留そのものを止めない
      }
      printHints(osDir);
      return 0;
    }
    // 誤登録の取り下げ（F013）。何かが行われたタスクは取り下げられない
    if (sub === 'withdraw') {
      const id = args.positional[1];
      const reason = args.flags.reason ? String(args.flags.reason) : args.positional.slice(2).join(' ');
      if (!id || !reason) throw new Error('使い方: autopoiesys task withdraw <id> --reason "<なぜ誤登録だったか>"');
      const t = evaluate.withdrawTask(osDir, id, reason);
      out({ task: t.id, status: t.status, withdrawn_reason: t.withdrawn_reason }, args.flags);
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
      // tsを残す。これが無いと「PLANを事前に固定したのか、成果を見た後に書いたのか」を
      // 台帳から判定できず、plan-verifyは常に「判定不能」しか返せない
      const updated = evaluate.addArtifact(osDir, id, {
        path: String(args.flags.path),
        note: args.flags.note ? String(args.flags.note) : '',
      });
      out({ task: id, artifacts: (updated.artifacts || []).length, added: String(args.flags.path) }, args.flags);
      // 成果物登録は完了報告の直前に通る地点。ここで未評価を告げないと、
      // 評価器を呼ばないまま完成報告する経路が開いたままになる
      printHints(osDir);
      return 0;
    }
    if (sub === 'plan') {
      const id = args.positional[1];
      if (!id || !args.flags.file) throw new Error('使い方: autopoiesys task plan <id> --file <PLANのパス>');
      const r = plan.registerPlan(osDir, id, String(args.flags.file));
      out(r, args.flags);
      // 受け入れ条件は設計判断が符号化される地点であり、ここはまだ何も作っていないので
      // 方向を変えられる。完成物への目的適合判定は、すでに費やしたものを取り戻さない
      // （実測: 領域固有の器官を作った回は、実装と2回の判定で30万トークンを使ってから破棄になった）。
      // 判定するのは独立サブエージェントであって人間ではない
      try {
        const t = evaluate.getTask(osDir, id);
        const abs = plan.resolvePlanPath(osDir, t, String(args.flags.file));
        const pr = require('../core/planreview').preparePlanReview(osDir, t, abs, r.path);
        let model = null;
        try {
          model = routing.modelForTier(schema.loadConfig(osDir), 'T1');
        } catch {
          model = null;
        }
        process.stdout.write(
          `\n計画の目的適合を、作り始める前に判定させること（briefing: ${pr.file}${model ? ` / tier T1 → モデル: ${model}` : ''}）。\n`
          + '会話履歴を持たない独立サブエージェントに渡し、`node cli/index.js verdict --file <json>` で記録させる。\n'
        );
      } catch (e) {
        // 失敗を画面に出すだけでは、後から「この計画は判定にかけられたのか」を機械記録から
        // 引けない。押し出す機構が黙って落ちたことは、台帳に残らなければ起きなかったのと同じになる
        try {
          util.appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
            ts: util.nowIso(),
            kind: 'plan_review_failed',
            task: id,
            plan: r.path,
            error: String(e.message),
            tokens_est: 0,
          });
        } catch {
          // 記録にも失敗したなら画面出力だけが残る（主機能は止めない）
        }
        process.stdout.write(`\n（計画レビューのbriefingを作れなかった: ${e.message}。この失敗は台帳に記録した）\n`);
      }
      return 0;
    }
    if (sub === 'plan-verify') {
      const id = args.positional[1];
      if (!id) throw new Error('使い方: autopoiesys task plan-verify <id>');
      out(plan.verifyPlans(osDir, id), args.flags);
      return 0;
    }
    if (sub === 'set-evaluators') {
      const id = args.positional[1];
      const evaluators = String(args.flags.evaluators || '').split(',').map((s) => s.trim()).filter(Boolean);
      evaluate.updateTask(osDir, id, { evaluators });
      out({ task: id, evaluators }, args.flags);
      return 0;
    }
    // 納品。宣言（claims）の登録と即時反証の全held、評価ゲート緑を要求する。
    // 検収待ちの宣言が残れば delivered、無ければ settled になる
    if (sub === 'deliver') {
      const id = args.positional[1];
      if (!id) throw new Error('使い方: autopoiesys task deliver <id>');
      const r = evaluate.deliver(osDir, id);
      const shown = {
        task: id,
        status: r.status,
        claims: r.delivery.claims,
        held: r.delivery.held,
        pending: r.delivery.pending,
        unfalsifiable: r.delivery.unfalsifiable,
      };
      if (r.delivery.caveats) shown.caveats = r.delivery.caveats;
      if (r.delivery.waived) shown.waived = r.delivery.waived;
      out(shown, args.flags);
      if (r.delivery.pending.length) {
        process.stdout.write(
          `\n検収待ちの宣言が${r.delivery.pending.length}件（${r.delivery.pending.join(', ')}）。` +
          '現実が採点するまで完了ではない。結果が分かり次第 claim settle で記録すること\n'
        );
      }
      if (r.delivery.unfalsifiable.length) {
        process.stdout.write(
          `\n開示: 反証手続きの無い宣言が${r.delivery.unfalsifiable.length}件（${r.delivery.unfalsifiable.join(', ')}）。` +
          'この部分の乖離は測定できない — 完了報告に必ず転記すること\n'
        );
      }
      if (r.delivery.caveats && r.delivery.caveats.length) {
        process.stdout.write('\ncaveats（完了報告にそのまま転記する）:\n'
          + r.delivery.caveats.map((c) => `  - ${c}`).join('\n') + '\n');
      }
      // 蒸留は納品前に済ませる規律だが、強制はしない。無言だけを許さない
      const t = evaluate.getTask(osDir, id);
      if (!t.consolidated) {
        process.stdout.write(`\nヒント: 蒸留（task consolidate ${id}）が未記録のまま納品した。経験を生ログのまま捨てないこと\n`);
      }
      printHints(osDir);
      return 0;
    }
    throw new Error('使い方: autopoiesys task new|brief|list|show|note|artifact|withdraw|plan|plan-verify|consolidate|set-evaluators|deliver');
  },

  // 宣言台帳（claims）: 納品物の主張と反証手続き。検収は現実が行う。
  claim(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    const usage = '使い方: autopoiesys claim new <taskId> "<宣言の1文>" のいずれか1つ:\n' +
      '          --argv \'["node","--test"]\' [--expect-exit 0] [--scope repo] [--timeout-ms n]（コマンドが剥がす）\n' +
      '          --file-matches <path> --pattern <re> [--scope repo] | --file-not-matches <path> --pattern <re>\n' +
      '          --deferred "<何がいつ剥がすか>" [--due YYYY-MM-DD]（現実・時間が採点する）\n' +
      '          --user-settles "<何がいつ剥がすか>"（ユーザーの検収だけが採点できる）\n' +
      '          --unfalsifiable "<なぜ反証手続きを書けないか>"（開示。納品記録に残る）\n' +
      '        autopoiesys claim list [--task T00x] [--pending]\n' +
      '        autopoiesys claim show <C000x>\n' +
      '        autopoiesys claim settle <C000x> [--result held|broke --evidence "<現実の観測>" [--source s]]';
    if (sub === 'new') {
      const taskId = args.positional[1];
      const body = args.positional.slice(2).join(' ');
      if (!taskId || !body) throw new Error(usage);
      let falsifier;
      if (args.flags.argv) {
        falsifier = { type: 'command', argv: JSON.parse(String(args.flags.argv)) };
        if (args.flags['expect-exit'] !== undefined) falsifier.expect_exit = Number(args.flags['expect-exit']);
        if (args.flags['timeout-ms'] !== undefined) falsifier.timeout_ms = Number(args.flags['timeout-ms']);
      } else if (args.flags['file-matches'] || args.flags['file-not-matches']) {
        const isMatch = !!args.flags['file-matches'];
        falsifier = {
          type: isMatch ? 'file_matches' : 'file_not_matches',
          path: String(isMatch ? args.flags['file-matches'] : args.flags['file-not-matches']),
          pattern: String(args.flags.pattern || ''),
        };
      } else if (args.flags.deferred) {
        falsifier = { type: 'deferred', how: String(args.flags.deferred) };
        if (args.flags.due) falsifier.due = String(args.flags.due);
      } else if (args.flags['user-settles']) {
        falsifier = { type: 'user', how: String(args.flags['user-settles']) };
      }
      if (falsifier && args.flags.scope) falsifier.scope = String(args.flags.scope);
      const r = claims.newClaim(osDir, {
        task: taskId,
        body,
        falsifier,
        unfalsifiable_reason: args.flags.unfalsifiable ? String(args.flags.unfalsifiable) : undefined,
      });
      out(r, args.flags);
      return 0;
    }
    if (sub === 'list') {
      const { byId, byTask } = claims.loadClaims(osDir);
      let list = args.flags.task ? (byTask[String(args.flags.task)] || []) : Object.values(byId);
      if (args.flags.pending) list = list.filter((c) => c.state === 'pending');
      out(list.map((c) => ({
        id: c.id,
        task: c.task,
        state: c.state,
        broke_ever: c.broke_ever || undefined,
        body: c.body,
        falsifier: c.falsifier ? c.falsifier.type : 'unfalsifiable',
      })), args.flags);
      return 0;
    }
    if (sub === 'show') {
      out(claims.getClaim(osDir, args.positional[1]), args.flags);
      return 0;
    }
    if (sub === 'settle') {
      const id = args.positional[1];
      if (!id) throw new Error(usage);
      const r = claims.settleClaim(osDir, id, {
        result: args.flags.result ? String(args.flags.result) : undefined,
        evidence: args.flags.evidence ? [String(args.flags.evidence)] : undefined,
        source: args.flags.source ? String(args.flags.source) : undefined,
      });
      out(r, args.flags);
      if (r.result === 'broke') {
        process.stdout.write(
          '\n宣言が剥がれた。これは宣言と実際の乖離であり、較正に恒久に記録される。\n' +
          (r.reopened ? 'タスクはopenへ戻した。' : '') +
          '症状をFailureとして起票すること: node cli/index.js feedback "<症状>" --task <taskId>\n'
        );
      }
      if (r.task_settled) {
        process.stdout.write('\n全宣言の検収が確定した。タスクはsettledになった\n');
      }
      printHints(osDir);
      return 0;
    }
    throw new Error(usage);
  },

  // 信用価格の開示: 較正実績と現在の監査率。実績が裁量を決める（実績以外の何も決めない）
  trust(args) {
    const osDir = requireOsDir(args.flags);
    const cfg = schema.loadConfig(osDir);
    const tc = claims.trustConfig(cfg);
    const global = claims.calibration(osDir);
    const result = { config: tc, global };
    if (args.flags.class) {
      const fp = taskclass.classFingerprint(String(args.flags.class));
      result.class = { class: String(args.flags.class), ...claims.calibration(osDir, { classFp: fp }) };
    }
    out(result, args.flags);
    const lines = claims.calibrationLines(osDir, {});
    if (lines.length) process.stdout.write('\n' + lines.join('\n') + '\n');
    return 0;
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
        pending.map((p) => `  ${p.briefing}`
          + (p.model ? `（tier ${p.tier} → モデル: ${p.model}）` : ''))
          .join('\n') + '\n'
      );
    }
    // 同じ状態を二度判定させない。判定1本は数万トークンかかるので、握りつぶさず理由を見せる
    for (const x of r.results.filter((y) => y.skipped === 'unchanged')) {
      process.stdout.write(`\nヒント: ${x.evaluator} は再判定しなかった。${x.why}\n`);
    }
    // 監査免除は較正実績が買った裁量。免除の事実と根拠を必ず見せる（黙って薄くしない）
    for (const x of r.results.filter((y) => y.skipped === 'sampled_out')) {
      process.stdout.write(`\n監査免除: ${x.evaluator}。${x.why}\n`);
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
    // caveatsは「evaluatorは全てPASSだが、この目的は測れていない」の宣言。
    // 出力から落とすとDELIVERが「Goalが測れている」と読まれる
    const shown = { task: r.task, action: r.action, why: r.why, missing: r.missing };
    if (r.waived) shown.waived = r.waived;
    if (r.caveats) shown.caveats = r.caveats;
    out(shown, args.flags);
    printHints(osDir);
    return 0;
  },

  // 文脈境界の宣言（F007由来）。知性・経験再利用の検証で効く変数は暦日ではなく
  // 文脈の分離（会話履歴を共有しない別プロセスか）である。セッションの開始を台帳に
  // 宣言することで、以後の全記録（タスク・教訓・配信）がtsで文脈に割り当てられる。
  // 宣言を忘れると文脈が過少計上され、知性の基準（sc-005/006）は不合格側に倒れる
  // — 偽の知性を作る方向には壊れない（fail-safe）
  session(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    const file = path.join(osDir, 'observations', 'sessions.jsonl');
    if (sub === 'begin') {
      const rows = util.readJsonl(file);
      const entry = { ts: util.nowIso(), n: rows.length + 1, note: args.flags.note ? String(args.flags.note) : undefined };
      if (entry.note === undefined) delete entry.note;
      util.appendJsonl(file, entry);
      out({ session: entry.n, ts: entry.ts, message: 'この文脈の開始を宣言した。以後の記録はこの文脈に割り当てられる' }, args.flags);
      printHints(osDir);
      return 0;
    }
    if (sub === 'list' || sub === undefined) {
      out(util.readJsonl(file), args.flags);
      return 0;
    }
    throw new Error('使い方: autopoiesys session begin [--note "<何のセッションか>"] | session list');
  },

  // 決定は判断の場（situation）に紐づく。記録しようとした瞬間にコアが過去を突き返し、
  // 反復して結果が伴えば方針へ畳み込まれる。支援対象はAI自身であって人間ではないので、
  // 期限や催促のような人間向けの装置は持たない（契機は日付ではなく再来である）。
  decision(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    const relay = (r) => {
      for (const k of ['message_policy', 'message']) {
        if (r[k]) process.stdout.write('\n警告: ' + r[k] + '\n');
      }
      if (r.contradicts_policy) process.stdout.write('\n警告: ' + r.contradicts_policy.message + '\n');
      for (const m of (r.recall && r.recall.messages) || []) process.stdout.write('\nヒント: ' + m + '\n');
    };
    if (sub === 'new') {
      const body = args.positional.slice(1).join(' ');
      if (!body) throw new Error('使い方: autopoiesys decision new "<何を決めたか>" --situation "<何を選ぶ場面か>" --options a,b --chosen a --criteria c1,c2 --expected "<期待結果>" [--tags t] [--scope s] [--task <id>]');
      const r = decision.newDecision(osDir, body, {
        situation: args.flags.situation ? String(args.flags.situation) : undefined,
        options: list(args.flags.options),
        chosen: args.flags.chosen ? String(args.flags.chosen) : undefined,
        criteria: list(args.flags.criteria),
        expected_outcome: args.flags.expected ? String(args.flags.expected) : undefined,
        tags: list(args.flags.tags),
        scope: list(args.flags.scope),
        source: args.flags.source ? String(args.flags.source) : undefined,
        method: args.flags.method ? String(args.flags.method) : undefined,
        task: args.flags.task ? String(args.flags.task) : undefined,
      });
      out(r, args.flags);
      relay(r);
      printHints(osDir);
      return 0;
    }
    // 決める前に引く。ここが最も安い経路（推論ゼロ）であり、run-taskはこれを先に通る
    if (sub === 'recall') {
      const situation = args.positional.slice(1).join(' ') || (args.flags.situation ? String(args.flags.situation) : '');
      if (!situation) throw new Error('使い方: autopoiesys decision recall "<何を選ぶ場面か>"（選択肢は場の同定に使わない）');
      const r = decision.recall(osDir, { situation, options: list(args.flags.options) });
      out(r, args.flags);
      for (const m of r.messages) process.stdout.write('\nヒント: ' + m + '\n');
      return 0;
    }
    if (sub === 'list') {
      out(decision.listDecisions(osDir, { unreviewed: !!args.flags.unreviewed }), args.flags);
      return 0;
    }
    if (sub === 'outcome') {
      const id = args.positional[1];
      if (!id || !args.flags.result) throw new Error(`使い方: autopoiesys decision outcome <id> --result ${decision.OUTCOME_RESULTS.join('|')} [--note "<観測>"] [--task <id>]`);
      const r = decision.recordOutcome(osDir, id, {
        result: String(args.flags.result),
        note: args.flags.note ? String(args.flags.note) : undefined,
        source: args.flags.source ? String(args.flags.source) : undefined,
        method: args.flags.method ? String(args.flags.method) : undefined,
        task: args.flags.task ? String(args.flags.task) : undefined,
      });
      out(r, args.flags);
      relay(r);
      printHints(osDir);
      return 0;
    }
    throw new Error('使い方: autopoiesys decision new|recall|list|outcome');
  },

  // 方針層（直感）。反復して結果が伴った決定の畳み込みで、発火にLLM推論を使わない。
  policy(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0] || 'list';
    if (sub === 'list') {
      out(policy.listPolicies(osDir, { activeOnly: !!args.flags.active }), args.flags);
      return 0;
    }
    if (sub === 'match') {
      const situation = args.positional.slice(1).join(' ') || (args.flags.situation ? String(args.flags.situation) : '');
      if (!situation) throw new Error('使い方: autopoiesys policy match "<何を選ぶ場面か>"（選択肢は場の同定に使わない）');
      // --options は受け取るが場の同定には使わない（互換のために落とさないだけ）
      const r = policy.match(osDir, {
        situation,
        task: args.flags.task ? String(args.flags.task) : undefined,
      });
      out(r, args.flags);
      if (r.hit) {
        process.stdout.write(`\nヒント: 確立済みの方針がある → ${r.policy.choose}（推論を経ていない。反する判断をするなら理由を残すこと）\n`);
      }
      return 0;
    }
    // 通常は decision new / outcome の中で自動的に走る。手動実行は取りこぼしの回収用
    if (sub === 'compile') {
      const r = policy.compile(osDir, {
        fingerprint: args.flags.fingerprint ? String(args.flags.fingerprint) : undefined,
      });
      out(r, args.flags);
      return 0;
    }
    if (sub === 'show') {
      const fp = args.positional[1];
      if (!fp) throw new Error('使い方: autopoiesys policy show <fingerprint>');
      out(policy.getPolicy(osDir, fp), args.flags);
      return 0;
    }
    throw new Error('使い方: autopoiesys policy list [--active] | match "<場面>"（選択肢は場の同定に使わない） | compile | show <fingerprint>');
  },

  // config.yaml の routing 表から推奨tierを引く。宣言されているだけで誰も読まない表は
  // 運用では守られないので、tierを自己申告ではなく表から導出する。
  route(args) {
    const osDir = requireOsDir(args.flags);
    let cfg = null;
    try { cfg = schema.loadConfig(osDir); } catch { cfg = null; }
    const r = routing.recommendTier(cfg, {
      purpose: args.flags.purpose ? String(args.flags.purpose) : (args.positional[0] || undefined),
      signals: args.flags.signals ? String(args.flags.signals).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
    out(r, args.flags);
    return 0;
  },

  // 類型ごとの試行系列。成長しているかの判定材料（系列を並べるだけで断定はしない）
  growth(args) {
    const osDir = requireOsDir(args.flags);
    if (args.flags.json) {
      out(growth.growthSeries(osDir), args.flags);
      return 0;
    }
    process.stdout.write(growth.growthReport(osDir, args.positional[0]).join('\n') + '\n');
    return 0;
  },

  // 蒸留申告の独立監査（S0035）。helped/misledは申告者=実行者のまま台帳に載るので、
  // 台帳の機械記録だけを別文脈の判定者に渡して、申告と記録の整合を見る経路を作る
  experience(args) {
    const osDir = requireOsDir(args.flags);
    const sub = args.positional[0];
    const usage = '使い方: autopoiesys experience audit <task> | audit-record <task> --lesson <S00xx> --result supported|contradicted|insufficient [--note "..."] | audits [<task>]';
    if (sub === 'audit') {
      const id = args.positional[1];
      if (!id) throw new Error(usage);
      const r = claimaudit.buildClaimAudit(osDir, id);
      out({ task: id, briefing: r.file, claimed: r.claimed.map((c) => `${c.lesson}(${c.role})`), tokens_est: r.tokens_est }, args.flags);
      if (!args.flags.json) {
        process.stdout.write('\n会話履歴を持たない別のサブエージェントに、このbriefingファイルだけを渡して判定させること。\n');
        if (!r.claimed.length) {
          process.stdout.write('注記: helped/misledの申告が無いため、監査対象がない（先に task consolidate を行う）\n');
        }
      }
      return 0;
    }
    if (sub === 'audit-record') {
      const id = args.positional[1];
      if (!id) throw new Error(usage);
      const r = claimaudit.recordClaimAudit(osDir, {
        task: id,
        lesson: args.flags.lesson ? String(args.flags.lesson) : undefined,
        result: args.flags.result ? String(args.flags.result) : undefined,
        note: args.flags.note ? String(args.flags.note) : undefined,
        source: args.flags.source ? String(args.flags.source) : undefined,
      });
      out(r, args.flags);
      return 0;
    }
    if (sub === 'audits') {
      const rows = claimaudit.claimAudits(osDir, args.positional[1]);
      out({ coverage: claimaudit.auditCoverage(osDir), audits: rows }, args.flags);
      return 0;
    }
    throw new Error(usage);
  },

  // 指示なしで次の仕事を出す。未解決のUnknown・止まったFailure・外れた教訓・
  // 未蒸留の完了タスク・測れていない基準から決定的に導出する
  agenda(args) {
    const osDir = requireOsDir(args.flags);
    if (args.flags.json) {
      out(agendaMod.agenda(osDir), args.flags);
      return 0;
    }
    const limit = args.flags.limit ? Number(args.flags.limit) : 10;
    process.stdout.write(agendaMod.agendaReport(osDir, { limit }).join('\n') + '\n');
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
      // 検出者の正直な記録。既定はuser_feedback（人間の指摘）。機械の検出器が起票する
      // 場合は --source goal_audit 等を明示する — これを混ぜると「短絡の検出者は常に人間か」
      // という問い（C5）の台帳が嘘をつく
      source: args.flags.source ? String(args.flags.source) : undefined,
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
    if (args.positional[0] !== 'add') throw new Error('使い方: autopoiesys ledger add --purpose p --tier T2 [--tokens-in N --tokens-out N | --tokens-total N] [--measured] [--task T001] [--model m] [--session R001] [--assets a,b]\n  トークンは任意。入れる場合は既定で見積り扱い（estimated: true）になり、API実測値のときだけ --measured を付ける\n  内訳が分からない実測（サブエージェントの消費合計など）は --tokens-total を使う（0を埋めない）');
    const r = knowledge.ledgerAdd(osDir, {
      purpose: args.flags.purpose ? String(args.flags.purpose) : undefined,
      tier: String(args.flags.tier || ''),
      model: args.flags.model ? String(args.flags.model) : '',
      tokens_in: args.flags['tokens-in'],
      tokens_out: args.flags['tokens-out'],
      tokens_total: args.flags['tokens-total'],
      measured: args.flags.measured === true,
      task: args.flags.task ? String(args.flags.task) : undefined,
      session: args.flags.session ? String(args.flags.session) : undefined,
      asset_refs: args.flags.assets ? String(args.flags.assets).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
    out(r, args.flags);
    // ledgerはrun-taskの最後に通る地点。ここでも未評価タスクを告げる
    printHints(osDir);
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

  // 形式移行。scope（Statementの宛先）導入分の後埋めをここで行う。
  // 既定はdry-run。--apply で events.jsonl を書き換える（原本は .pre-scope-backfill に残る）。
  migrate(args) {
    const osDir = requireOsDir(args.flags);
    const cfg = schema.loadConfig(osDir);
    const vocab = store.loadVocabulary(osDir);
    const scopes = args.flags.scopes
      ? String(args.flags.scopes).split(',').map((v) => v.trim()).filter(Boolean)
      : vocab.scopes;
    if (!scopes.length) {
      throw new Error('scopeの登録簿が空。world_model/vocabulary.yaml に scopes: を定義するか --scopes a,b で渡せ');
    }
    const report = store.backfillScope(osDir, {
      scopes,
      fallbackScope: args.flags['fallback-scope'] ? String(args.flags['fallback-scope']) : undefined,
      apply: !!args.flags.apply,
    });
    // format_versionが同じでも「Coreが後から同梱したファイルが届いていない」ことはある。
    // 移行の要否をここで聞かれる以上、その不足もここで名指しする
    const missingBundled = scaffold.missingBundledQueries(osDir);
    out({
      current_format: cfg.format_version,
      core_format: schema.FORMAT_VERSION,
      scopes,
      scope_backfill: report,
      missing_bundled_queries: missingBundled,
      message: report.applied
        ? 'scopeを後埋めした。check で整合を確認せよ'
        : 'dry-run（--apply で適用）。scopeの写し先が意図どおりか by_scope を確認せよ',
    }, args.flags);
    if (missingBundled.length) {
      process.stdout.write(
        `\n警告: Coreが同梱するQueryが${missingBundled.length}件この.osに無い（${missingBundled.join(', ')}）。\n`
        + 'autopoiesys init --force で不足分だけ補える（config・goal・語彙などの既存ファイルは上書きしない）。\n'
      );
    }
    return 0;
  },

  version(args) {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    out({ autopoiesys: pkg.version, format_version: schema.FORMAT_VERSION, node: process.versions.node }, args.flags);
    return 0;
  },

  help() {
    process.stdout.write(`autopoiesys — Intelligence OSの決定的コア

環境・初期化:   doctor / init [--dir D] [--force] / skills sync [--dir D] [--check] / version / migrate [--apply]
検証:           validate / check / rebuild
World Model:    assert --file s.json / statement add|supersede|show / query [name] [--param k=v]
                ingest repo|rules|memory|knowledge|all [--scope S] [--repo D] [--check]
知識源と到達性:  sources scan [--emit] / audit reachability
Intelligence Graph: relate <s> <p> <o> "<説明>" / gap [--goal S00xx] [--assert] [--criteria-only]
タスクと評価:   task new "<objective>" --verbatim "<依頼の原文>" --class "<類型の1行>" [--repos <scope>[=<dir>],...]
                         [--origin agenda:<ref>|failure:F00x|lesson:S00xx|unknown:S00xx|user]
                task brief T（想起の束を取り直す）/ list|show|note|artifact
                task withdraw T --reason "<誤登録の理由>"（何もしていないタスクに限る）
                task plan T --file PLAN.md / task plan-verify T（手順の事前固定）
                task consolidate T --lessons S00x,... [--helped ..] [--misled ..]
                         [--unapplied .. --unapplied-reason "<理由>"]（蒸留）
                evaluate --task T / verdict --file v.json / next-action T
納品と検収:     claim new T "<宣言>" --argv '["node","--test"]' | --file-matches p --pattern re
                         | --deferred "<何がいつ剥がすか>" [--due 日付] | --user-settles "<同>"
                         | --unfalsifiable "<理由>"（反証手続きの無い宣言は開示必須）
                claim list [--task T] [--pending] / claim show C000x
                claim settle C000x [--result held|broke --evidence "<現実の観測>"]
                task deliver T（納品。宣言と即時反証held、評価ゲート緑を要求）
                trust [--class "<類型>"]（較正実績と監査率）
成長:           growth [類型名の一部] （類型ごとの試行系列）
                agenda [--limit N] （指示なしで次の仕事を出す）
                experience audit T（蒸留申告の独立監査briefingを組む）
                experience audit-record T --lesson S00xx --result supported|contradicted|insufficient
                experience audits [T]（監査結果と被覆）
判断:           decision recall "<場面>"（決める前に引く。推論ゼロ）
                decision new "..." --situation "<場面>" --options a,b --chosen a
                decision list [--unreviewed] / decision outcome S00xx --result met|unmet|unclear
                policy list [--active] | match "<場面>" | compile | show <fp>（直感層）
                route --purpose <用途> [--signals s1,s2]
Failureループ:  feedback "..." / failure list|show|transition|lint / regression
文脈の配布:     context [--task T] [--purpose "<今から何をするか>"] [--queries q1,q2]
                         [--max-tokens N]（実行側・サブエージェントへ渡す最小Subgraph）
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
