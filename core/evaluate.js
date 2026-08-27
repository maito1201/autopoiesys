'use strict';
// 独立評価: Agentの「完了しました」を一切使わないコードパス（設計原則§9-10, §26③）。
// deterministic / command はコアが直接実行し、llm_judge は briefing 経由で
// 新規サブエージェントに判定させる（生成側の会話履歴は渡らない）。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJsonl, appendJsonl, nowIso, nextId, atomicWriteFile, readTextFile, stableStringify } = require('./util');
const { parseYaml } = require('./yaml');
const { runQuery } = require('./query');

const VERDICTS = ['PASS', 'FAIL', 'UNCERTAIN'];
const REASONS = ['insufficient_evidence', 'model_limitation', 'conflicting_evidence'];
const METHODS = ['deterministic', 'command', 'llm_judge'];
const CHECK_KINDS = ['file_exists', 'file_absent', 'file_matches', 'file_not_matches', 'query_empty', 'query_nonempty', 'query_matches', 'query_not_matches'];

function evaluatorsDir(osDir) {
  return path.join(osDir, 'evaluators');
}

function verdictLog(osDir) {
  return path.join(osDir, 'evaluations', 'log.jsonl');
}

function tasksFile(osDir) {
  return path.join(osDir, 'tasks', 'tasks.jsonl');
}

function loadEvaluatorDef(osDir, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`不正なEvaluator ID: ${id}`);
  const file = path.join(evaluatorsDir(osDir), `${id}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`Evaluatorが存在しない: ${id}（${file}）`);
  const def = parseYaml(readTextFile(file));
  const errors = validateEvaluatorDef(def);
  if (errors.length) throw new Error(`Evaluator定義エラー ${id}:\n  ${errors.join('\n  ')}`);
  // 大文字小文字非区別FS（NTFS/APFS）ではID違いでもファイルが読めてしまう。
  // Linuxに移送した瞬間に壊れるため、定義内idとの厳密一致をここで強制する。
  if (def.id !== id) {
    throw new Error(`Evaluator IDと定義内idが不一致: 要求=${id} 定義=${def.id}（大文字小文字も区別される）`);
  }
  return def;
}

function listEvaluators(osDir) {
  const dir = evaluatorsDir(osDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')).sort();
}

function validateEvaluatorDef(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['Evaluator定義がオブジェクトでない'];
  if (!def.id) errors.push('id欠落');
  if (!METHODS.includes(def.method)) errors.push(`methodは ${METHODS.join('|')}`);
  if (!def.tier || !/^T[0-3]$/.test(def.tier)) errors.push('tierはT0..T3');
  // scope: このEvaluatorがどのリポジトリで実行されるか。多リポジトリ横断タスクでは
  // evaluatorごとに実行ディレクトリが違うため、単一のwork_dirでは検証先を誤る。
  if (def.scope !== undefined && (typeof def.scope !== 'string' || !def.scope)) {
    errors.push('scopeは非空の文字列（対象リポジトリのscope名）');
  }
  if (def.method === 'deterministic') {
    if (!Array.isArray(def.checks) || def.checks.length === 0) errors.push('deterministicはchecks必須');
    for (const c of def.checks || []) {
      if (!c || !CHECK_KINDS.includes(c.kind)) errors.push(`未知のcheck kind: ${c && c.kind}`);
      if (c && c.kind && c.kind.startsWith('file_') && !c.path) errors.push(`${c.kind}: path必須`);
      if (c && (c.kind === 'file_matches' || c.kind === 'file_not_matches') && !c.pattern) errors.push(`${c.kind}: pattern必須`);
      if (c && c.kind && c.kind.startsWith('query_') && !c.query) errors.push(`${c.kind}: query必須`);
      if (c && (c.kind === 'query_matches' || c.kind === 'query_not_matches') && !c.pattern) errors.push(`${c.kind}: pattern必須`);
    }
  } else if (def.method === 'command') {
    if (!Array.isArray(def.argv) || def.argv.length === 0) errors.push('commandはargv配列必須（シェル文字列は禁止）');
  } else if (def.method === 'llm_judge') {
    if (!def.rubric) errors.push('llm_judgeはrubric必須');
  }
  return errors;
}

function runDeterministic(osDir, def, { workDir }) {
  const evidence = [];
  let failed = false;
  for (const c of def.checks) {
    try {
      if (c.kind === 'file_exists' || c.kind === 'file_absent') {
        const p = path.resolve(workDir, c.path);
        const exists = fs.existsSync(p);
        const ok = c.kind === 'file_exists' ? exists : !exists;
        evidence.push(`${c.kind} ${c.path}: ${exists ? 'exists' : 'absent'} -> ${ok ? 'ok' : 'NG'}`);
        if (!ok) failed = true;
      } else if (c.kind === 'file_matches' || c.kind === 'file_not_matches') {
        const p = path.resolve(workDir, c.path);
        if (!fs.existsSync(p)) {
          return { verdict: 'UNCERTAIN', evidence: [...evidence, `${c.kind} ${c.path}: ファイルが存在しない`], reason: 'insufficient_evidence' };
        }
        const content = readTextFile(p); // BOM/UTF-16も正しく読む（PowerShell成果物への偽FAIL防止）
        const re = new RegExp(c.pattern, 'm');
        const hit = re.test(content);
        const ok = c.kind === 'file_matches' ? hit : !hit;
        evidence.push(`${c.kind} ${c.path} /${c.pattern}/: ${hit ? 'match' : 'no-match'} -> ${ok ? 'ok' : 'NG'}`);
        if (!ok) failed = true;
      } else if (c.kind === 'query_empty' || c.kind === 'query_nonempty') {
        const res = runQuery(osDir, c.query, c.params || {});
        const ok = c.kind === 'query_empty' ? res.total === 0 : res.total > 0;
        evidence.push(`${c.kind} ${c.query}: total=${res.total} -> ${ok ? 'ok' : 'NG'}`);
        if (!ok) failed = true;
      } else if (c.kind === 'query_matches' || c.kind === 'query_not_matches') {
        // 「この知識がQueryの返却枠に実際に入るか」を検査する。件数だけでは
        // max_tokensの切詰めで重要な1件が落ちても気づけない
        const res = runQuery(osDir, c.query, c.params || {});
        const re = new RegExp(c.pattern);
        const hit = res.results.some((r) => re.test(stableStringify(r)));
        const ok = c.kind === 'query_matches' ? hit : !hit;
        evidence.push(
          `${c.kind} ${c.query} /${c.pattern}/: ${hit ? 'match' : 'no-match'} ` +
          `(count=${res.count}/${res.total}${res.truncated ? ', truncated' : ''}) -> ${ok ? 'ok' : 'NG'}`
        );
        if (!ok) failed = true;
      }
    } catch (e) {
      return { verdict: 'UNCERTAIN', evidence: [...evidence, `check実行エラー: ${e.message}`], reason: 'insufficient_evidence' };
    }
  }
  return { verdict: failed ? 'FAIL' : 'PASS', evidence };
}

// cmd.exe経由で安全に渡せない文字（引用・改行・cmdメタ文字・%展開）
const CMD_UNSAFE = /["\r\n&|^<>%]/;

// 子プロセスを別nodeプロセスのスーパーバイザ経由で実行する。
// 理由: spawnSyncのtimeoutは直下のプロセスしか殺せず、タイムアウト時に
// 実体（テストランナー等）が背後で生き残る。スーパーバイザは超過時に
// プロセスツリーごと殺す（win32=taskkill /T /F、POSIX=プロセスグループへSIGKILL）。
const SUPERVISOR_SRC = `
const { spawn, spawnSync } = require('node:child_process');
const cfg = JSON.parse(process.argv[1]);
const child = spawn(cfg.cmd, cfg.args, {
  cwd: cfg.cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsVerbatimArguments: cfg.verbatim === true,
  windowsHide: true,
  detached: process.platform !== 'win32',
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
let done = false;
let timedOut = false;
const finish = (obj) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(obj));
};
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}, cfg.timeout);
child.on('close', (code) => finish({ code, timedOut, output: out.slice(0, 2000) }));
child.on('error', (e) => finish({ error: e.message, errorCode: e.code }));
`;

function runViaSupervisor(cmd, args, { cwd, timeout, verbatim }) {
  const cfg = { cmd, args, cwd, timeout, verbatim: !!verbatim };
  const res = spawnSync(process.execPath, ['-e', SUPERVISOR_SRC, JSON.stringify(cfg)], {
    encoding: 'utf8',
    timeout: timeout + 15000,
    windowsHide: true,
  });
  if (res.error) return { error: res.error.message, errorCode: res.error.code };
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: `supervisor出力の解析失敗: ${(res.stdout || '').slice(0, 200)}` };
  }
}

// Windowsでのコマンド実体解決。パスを含む指定はworkDir相対で実在確認し、
// bare名はworkDirをcwdにしたwhereで解決する（CLIの起動ディレクトリに依存させない）。
function resolveWindowsCommand(base, workDir) {
  if (/[\\/]/.test(base)) {
    const abs = path.resolve(workDir, base);
    return fs.existsSync(abs) ? abs : null;
  }
  const found = spawnSync('where', [base], { encoding: 'utf8', windowsHide: true, cwd: workDir });
  if (found.error || found.status !== 0) return null;
  const first = (found.stdout || '').split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

function runCommand(def, { workDir }) {
  const argv = def.argv.map((a) => String(a));
  const timeout = def.timeout_ms || 120000;
  const base = argv[0] === 'node' ? process.execPath : argv[0];
  const args = argv.slice(1);
  let r = runViaSupervisor(base, args, { cwd: workDir, timeout });
  let note = null;
  // Windowsではnpm/npx等の実体が.cmdのためENOENT/EINVALになる。実体を解決して再試行する。
  if (r.error && process.platform === 'win32' && (r.errorCode === 'ENOENT' || r.errorCode === 'EINVAL')) {
    const resolved = resolveWindowsCommand(base, workDir);
    if (!resolved) {
      return { verdict: 'UNCERTAIN', evidence: [`コマンドが見つからない: ${base}`], reason: 'insufficient_evidence' };
    }
    if (/\.(cmd|bat)$/i.test(resolved)) {
      // cmd.exe経由は引数を再解釈する。安全に渡せない引数は実行せず評価不能とする
      // （OS間でverdictが分岐する静かな誤動作より、明示的なUNCERTAINを選ぶ）。
      const unsafe = args.find((a) => CMD_UNSAFE.test(a));
      if (unsafe !== undefined) {
        return {
          verdict: 'UNCERTAIN',
          evidence: [
            `${path.basename(resolved)} はcmd.exe経由の実行になるが、引数に安全に渡せない文字が含まれる: ${JSON.stringify(unsafe)}`,
            '回避策: nodeスクリプトのラッパーに包む（argv: [node, wrapper.js, ...]）',
          ],
          reason: 'insufficient_evidence',
        };
      }
      const line = `""${resolved}"${args.map((a) => ` "${a}"`).join('')}"`;
      r = runViaSupervisor('cmd.exe', ['/d', '/s', '/c', line], { cwd: workDir, timeout, verbatim: true });
      note = `note: cmd.exe経由で実行（${path.basename(resolved)}）。出力はUTF-8として解釈`;
    } else {
      r = runViaSupervisor(resolved, args, { cwd: workDir, timeout });
      note = `note: フルパス解決で実行（${resolved}）`;
    }
  }
  if (r.error) {
    return { verdict: 'UNCERTAIN', evidence: [`コマンド起動失敗: ${r.error}`], reason: 'insufficient_evidence' };
  }
  if (r.timedOut) {
    return {
      verdict: 'UNCERTAIN',
      evidence: [`タイムアウト（${timeout}ms）: プロセスツリーを強制終了した`],
      reason: 'insufficient_evidence',
    };
  }
  const expect = def.expect_exit === undefined ? 0 : def.expect_exit;
  const out = (r.output || '').slice(0, 800).replace(/\r\n/g, '\n');
  const pass = r.code === expect;
  const evidence = [`argv=${JSON.stringify(argv)}`, `exit=${r.code} (expect ${expect})`, `output: ${out}`];
  if (note) evidence.push(note);
  return { verdict: pass ? 'PASS' : 'FAIL', evidence };
}

// llm_judge: 判定依頼briefingを生成する。verdict自体は独立サブエージェントが
// `autopoiesys verdict --file` で記録する（このプロセスはLLMを呼ばない）。
function prepareLlmJudge(osDir, def, { task, artifacts }) {
  const parts = [];
  parts.push(`# 独立評価依頼: ${def.id}`);
  parts.push('');
  parts.push('あなたは独立評価者である。生成エージェントの会話履歴・自己申告は一切参照せず、');
  parts.push('このbriefingに含まれる情報と、ここに列挙されたファイルの実物のみで判定せよ。');
  parts.push('');
  parts.push(`## 対象タスク: ${task.id}`);
  parts.push(`Objective: ${task.objective}`);
  parts.push('');
  parts.push('## Artifact');
  for (const a of task.artifacts || []) parts.push(`- ${a.path}${a.note ? ` — ${a.note}` : ''}`);
  if (artifacts && artifacts.length) for (const a of artifacts) parts.push(`- ${a}`);
  parts.push('');
  // context_queriesは常に空paramsで呼ばれていたため、横断タスクでも絞り込みが効かなかった。
  // タスクの対象リポジトリをscopeとして渡す（カンマ区切りはOR = 触る全リポジトリの和集合）。
  const queryParams = {};
  const taskScopes = Object.keys(task.repo_dirs || {});
  if (taskScopes.length) queryParams.scope = taskScopes.join(',');
  for (const q of def.context_queries || []) {
    parts.push(`## Query: ${q}${taskScopes.length ? `（scope=${queryParams.scope}）` : ''}`);
    try {
      const res = runQuery(osDir, q, queryParams);
      parts.push('```json');
      parts.push(JSON.stringify(res, null, 1));
      parts.push('```');
    } catch (e) {
      parts.push(`(Query実行エラー: ${e.message})`);
    }
    parts.push('');
  }
  parts.push('## Rubric');
  parts.push(def.rubric);
  parts.push('');
  parts.push('## 出力方法');
  parts.push('判定JSONを一時ファイルに書き、次のコマンドで記録せよ:');
  parts.push('');
  parts.push('    node cli/index.js verdict --file <判定JSONのパス>');
  parts.push('');
  parts.push('判定JSONの形式:');
  parts.push('```json');
  parts.push(JSON.stringify({
    task: task.id,
    evaluator: def.id,
    verdict: 'PASS | FAIL | UNCERTAIN',
    evidence: ['根拠となる観測（ファイルパス・行・Query結果）を必ず列挙'],
    rationale: '判定理由',
    reason: '(UNCERTAINの場合) insufficient_evidence | model_limitation | conflicting_evidence',
    tokens: 0,
  }, null, 1));
  parts.push('```');
  const file = path.join(osDir, 'briefings', `eval-${task.id}-${def.id}.md`);
  atomicWriteFile(file, parts.join('\n') + '\n');
  return file;
}

// external: CLI（autopoiesys verdict）経由の外部記録。llm_judge評価のみ受理し、
// provenanceの自称（deterministic/replay偽装）を拒否する。
// deterministic/command/replayのverdictはevaluateTask内部からしか書けない（§26③の強制）。
function recordVerdict(osDir, v, { external = false } = {}) {
  const errors = [];
  if (!v.task) errors.push('task欠落');
  if (!v.evaluator) errors.push('evaluator欠落');
  if (!VERDICTS.includes(v.verdict)) errors.push(`verdictは ${VERDICTS.join('|')}`);
  if (!Array.isArray(v.evidence) || v.evidence.length === 0) errors.push('evidenceは1件以上必須（根拠のないverdictは記録できない）');
  if (v.reason && !REASONS.includes(v.reason)) errors.push(`reasonは ${REASONS.join('|')}`);
  if (errors.length) throw new Error(`verdict検証エラー:\n  ${errors.join('\n  ')}`);
  let provenance = v.provenance || 'llm';
  if (external) {
    getTask(osDir, v.task); // タスクの実在
    const def = loadEvaluatorDef(osDir, v.evaluator);
    if (def.method !== 'llm_judge') {
      throw new Error(
        `${v.evaluator} は ${def.method} 評価。外部からverdictを記録できるのはllm_judgeのみ` +
        '（deterministic/commandのverdictはautopoiesys evaluateが直接実行して記録する）'
      );
    }
    if (provenance !== 'human') provenance = 'llm'; // deterministic/replayの自称を拒否
  }
  const entry = {
    ts: nowIso(),
    task: v.task,
    evaluator: v.evaluator,
    verdict: v.verdict,
    evidence: v.evidence,
    rationale: v.rationale || '',
    provenance,
    tier: v.tier || 'T2',
    tokens: v.tokens || 0,
  };
  if (v.reason) entry.reason = v.reason;
  appendJsonl(verdictLog(osDir), entry);
  return entry;
}

// タスク台帳（同一idの最新行が現在状態）
function loadTasks(osDir) {
  const rows = readJsonl(tasksFile(osDir));
  const byId = {};
  for (const r of rows) byId[r.id] = { ...(byId[r.id] || {}), ...r };
  return byId;
}

function getTask(osDir, id) {
  const t = loadTasks(osDir)[id];
  if (!t) throw new Error(`タスクが存在しない: ${id}`);
  return t;
}

// extra: 引き継ぎに必要な作業文脈（work_dir=評価・作業対象ディレクトリ, refs=Issue/PR等のURL列, context=自由記述）。
// タスクは会話ではなくOSが継続性の正本になる: 別プロセスがresumeしても task show だけで再開できる状態を保つ。
// repo_dirs: scope → そのリポジトリでの作業ディレクトリ（worktree等）。横断タスクでは
// evaluatorごとに実行先が違うため、単一のwork_dirでは検証先を誤る（api_testをRNのdirで走らせる等）。
function newTask(osDir, objective, evaluators, extra = {}) {
  const byId = loadTasks(osDir);
  const id = nextId('T', Object.keys(byId), 3);
  const entry = { id, ts: nowIso(), objective, status: 'open', artifacts: [], evaluators: evaluators || [] };
  if (extra.work_dir) entry.work_dir = extra.work_dir;
  if (extra.repo_dirs && Object.keys(extra.repo_dirs).length) entry.repo_dirs = extra.repo_dirs;
  if (extra.refs && extra.refs.length) entry.refs = extra.refs;
  if (extra.context) entry.context = extra.context;
  // 実行先が決まらないevaluatorを登録させない（登録時に落とす方が、評価時に誤ったdirで
  // PASSを出すより安全。評価Evaluatorの選定を後から緩めるのは禁止という規律とも整合する）
  const missing = [];
  for (const evId of entry.evaluators) {
    let def;
    try {
      def = loadEvaluatorDef(osDir, evId);
    } catch {
      continue; // 存在しないevaluatorはcheckAll側で報告される
    }
    if (def.scope && !(entry.repo_dirs && entry.repo_dirs[def.scope])) missing.push(`${evId}(scope=${def.scope})`);
  }
  if (missing.length) {
    throw new Error(
      `evaluatorの実行先ディレクトリが未指定: ${missing.join(', ')}。` +
      '--repos <scope>[=<dir>],... で対象リポジトリを登録せよ（=dir省略時はgoal.yaml sourcesのrepoを使う）'
    );
  }
  appendJsonl(tasksFile(osDir), entry);
  return entry;
}

function updateTask(osDir, id, patch) {
  const t = getTask(osDir, id);
  const entry = { ...t, ...patch, id, ts: nowIso() };
  appendJsonl(tasksFile(osDir), entry);
  return entry;
}

// チェックポイント追記。中間状態（検証済み事実・現在のステップ・次アクション）を
// 会話文脈でなくタスク台帳に残し、プロセスを跨いだ引き継ぎを可能にする。
function addTaskNote(osDir, id, note) {
  if (!note) throw new Error('noteが必要');
  const t = getTask(osDir, id);
  const notes = [...(t.notes || []), { ts: nowIso(), note }];
  return updateTask(osDir, id, { notes });
}

// タスクの全Evaluatorを実行。det/commandは即verdict追記、llm_judgeはbriefing生成のみ。
function evaluateTask(osDir, taskId, { only, workDir, replay } = {}) {
  const task = getTask(osDir, taskId);
  if (!task.evaluators || task.evaluators.length === 0) {
    throw new Error(`タスク ${taskId} にevaluatorが設定されていない（autopoiesys task new --evaluators で指定）`);
  }
  const results = [];
  for (const evId of task.evaluators) {
    if (only && evId !== only) continue;
    const def = loadEvaluatorDef(osDir, evId);
    if (def.method === 'llm_judge') {
      if (replay && replay[evId]) {
        // replayは「記録済みの独立判定の再生」であって新規判定の経路ではない。
        // 生成エージェントが--replayで任意のPASSを注入する迂回を防ぐため、
        // 過去のllm/human判定と一致する場合のみ受理する（§26③）。
        const prior = readJsonl(verdictLog(osDir)).filter(
          (r) => r.task === taskId && r.evaluator === evId && (r.provenance === 'llm' || r.provenance === 'human')
        );
        const last = prior[prior.length - 1];
        if (!last) {
          throw new Error(
            `replay不可: ${evId} には記録済みの独立判定（llm/human）が存在しない。` +
            'まず独立サブエージェントによる判定を autopoiesys verdict で記録せよ'
          );
        }
        if (last.verdict !== replay[evId]) {
          throw new Error(
            `replay不一致: ${evId} の記録済みverdictは ${last.verdict}（${last.ts}）。` +
            `replay値 ${replay[evId]} は受理できない`
          );
        }
        const entry = recordVerdict(osDir, {
          task: taskId,
          evaluator: evId,
          verdict: last.verdict,
          evidence: [`replay: ${last.ts} に記録された${last.provenance}判定のリプレイ`],
          provenance: 'replay',
          tier: def.tier,
        });
        results.push({ evaluator: evId, method: def.method, ...entry });
      } else {
        const briefing = prepareLlmJudge(osDir, def, { task });
        results.push({ evaluator: evId, method: def.method, pending: true, briefing });
      }
      continue;
    }
    // 実行ディレクトリの決定順:
    //   ① def.scope が宣言されていれば task.repo_dirs[scope]（--work-dirでも上書きさせない。
    //      横断タスクで一括指定されたdirがscope付きevaluatorを誤った場所で走らせる事故を防ぐ）
    //   ② scope無しのevaluatorは --work-dir → task.work_dir → cwd
    let effectiveWorkDir;
    if (def.scope) {
      effectiveWorkDir = (task.repo_dirs || {})[def.scope];
      if (!effectiveWorkDir) {
        // 実行先不明のまま走らせて誤ったPASSを出さない。証拠不足として扱いループを止めない
        const entry = recordVerdict(osDir, {
          task: taskId,
          evaluator: evId,
          verdict: 'UNCERTAIN',
          evidence: [`scope=${def.scope} の作業ディレクトリがタスクに登録されていない`],
          reason: 'insufficient_evidence',
          provenance: 'deterministic',
          tier: def.tier,
          tokens: 0,
        });
        results.push({ evaluator: evId, method: def.method, ...entry });
        continue;
      }
    } else {
      effectiveWorkDir = workDir || task.work_dir || process.cwd();
    }
    const r = def.method === 'deterministic'
      ? runDeterministic(osDir, def, { workDir: effectiveWorkDir })
      : runCommand(def, { workDir: effectiveWorkDir });
    const entry = recordVerdict(osDir, {
      task: taskId,
      evaluator: evId,
      verdict: r.verdict,
      evidence: r.evidence,
      reason: r.reason,
      provenance: 'deterministic',
      tier: def.tier,
      tokens: 0,
    });
    results.push({ evaluator: evId, method: def.method, ...entry });
  }
  return { task, results };
}

function latestVerdicts(osDir, taskId) {
  const rows = readJsonl(verdictLog(osDir)).filter((r) => r.task === taskId);
  const latest = {};
  for (const r of rows) latest[r.evaluator] = r;
  return latest;
}

// evaluatorごとの「最新の決定的verdict」。後からのllm verdictでは上書きされない視界を持つ。
function latestDeterministicVerdicts(osDir, taskId) {
  const rows = readJsonl(verdictLog(osDir)).filter((r) => r.task === taskId);
  const latest = {};
  for (const r of rows) if (r.provenance === 'deterministic') latest[r.evaluator] = r;
  return latest;
}

// Next Action Engine（設計原則§11）。決定的FAILはLLM判定で覆せない。
// 対象evaluatorは task.evaluators と verdict記録済みevaluatorの和集合 —
// 評価後にevaluatorを外しても、記録済みFAILは視界から消えない。
function nextAction(osDir, taskId) {
  const task = getTask(osDir, taskId);
  const latest = latestVerdicts(osDir, taskId);
  const latestDet = latestDeterministicVerdicts(osDir, taskId);
  const evaluators = [...new Set([...(task.evaluators || []), ...Object.keys(latest)])];
  const detail = [];
  const missing = [];
  for (const evId of evaluators) {
    if (!latest[evId]) missing.push(evId);
    else detail.push(latest[evId]);
  }
  let action;
  let why;
  const detFail = Object.values(latestDet).find((v) => v.verdict === 'FAIL')
    || detail.find((v) => v.provenance === 'deterministic' && v.verdict === 'FAIL');
  const anyFail = detail.find((v) => v.verdict === 'FAIL');
  const modelLimit = detail.find((v) => v.reason === 'model_limitation');
  const conflict = detail.find((v) => v.reason === 'conflicting_evidence');
  const insufficient = detail.find((v) => v.reason === 'insufficient_evidence');
  const uncertain = detail.find((v) => v.verdict === 'UNCERTAIN');
  if (detFail) {
    action = 'FIX';
    why = `決定的評価がFAIL: ${detFail.evaluator}（LLM判定では覆せない）`;
  } else if (anyFail) {
    action = 'FIX';
    why = `FAIL: ${anyFail.evaluator}`;
  } else if (missing.length) {
    action = 'COLLECT_EVIDENCE';
    why = `verdict未記録のevaluator: ${missing.join(', ')}`;
  } else if (conflict) {
    action = 'RESOLVE_CONFLICT';
    why = `矛盾する証拠: ${conflict.evaluator}`;
  } else if (modelLimit) {
    action = 'DEEP_RESEARCH';
    why = `モデル限界の申告: ${modelLimit.evaluator}`;
  } else if (insufficient) {
    action = 'COLLECT_EVIDENCE';
    why = `証拠不足: ${insufficient.evaluator}`;
  } else if (uncertain) {
    action = 'INVESTIGATE';
    why = `UNCERTAIN: ${uncertain.evaluator}`;
  } else if (detail.length && detail.every((v) => v.verdict === 'PASS')) {
    action = 'DONE';
    why = `全${detail.length}件のevaluatorがPASS`;
  } else {
    action = 'COLLECT_EVIDENCE';
    why = 'verdictが1件もない';
  }
  // statusは常に最新のactionに従う（一度doneでも新たなFAILでopenに戻る）
  updateTask(osDir, taskId, { status: action === 'DONE' ? 'done' : 'open', last_action: action });
  return { task: taskId, action, why, verdicts: detail, missing };
}

module.exports = {
  VERDICTS,
  loadEvaluatorDef,
  listEvaluators,
  validateEvaluatorDef,
  runDeterministic,
  runCommand,
  prepareLlmJudge,
  recordVerdict,
  loadTasks,
  getTask,
  newTask,
  updateTask,
  addTaskNote,
  evaluateTask,
  latestVerdicts,
  nextAction,
};
