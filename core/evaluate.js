'use strict';
// 独立評価: Agentの「完了しました」を一切使わないコードパス（設計原則§9-10, §26③）。
// deterministic / command はコアが直接実行し、llm_judge は briefing 経由で
// 新規サブエージェントに判定させる（生成側の会話履歴は渡らない）。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJsonl, appendJsonl, nowIso, nextId, atomicWriteFile, readTextFile, stableStringify, estimateTokens } = require('./util');
const { parseYaml } = require('./yaml');
const { runQuery } = require('./query');
const { buildReasoningContext } = require('./context');

const VERDICTS = ['PASS', 'FAIL', 'UNCERTAIN'];
// insufficient_sample: 「やり方を変えれば届く」証拠不足（insufficient_evidence）と、
// 「入力そのものが足りず原理的に届かない」検出力不足を区別する。混ぜると、
// 標本を増やすべき場面で手法の作り直しを繰り返す（E3 / kabu core-underpowered-goal-state）。
const REASONS = ['insufficient_evidence', 'insufficient_sample', 'model_limitation', 'conflicting_evidence'];
const METHODS = ['deterministic', 'command', 'llm_judge'];
// 何を見る評価器か。conformance=規定への適合（枠・語彙・引用・プロセス）、
// outcome=目的の達成（外側の効果）。両者を区別しないと、適合だけを全通過して
// 目的未達の成果物が完成扱いになる。
const EVALUATOR_KINDS = ['conformance', 'outcome'];
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
  if (def.kind !== undefined && !EVALUATOR_KINDS.includes(def.kind)) {
    errors.push(`kindは ${EVALUATOR_KINDS.join('|')}`);
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
// briefingに同梱する「OSが機械記録した検証実績」。判定中のevaluator自身は除く
// （まだverdictが無いのが正常であり、含めると自己参照になる）。
function recordedVerificationSection(osDir, task, def) {
  const rows = readJsonl(verdictLog(osDir))
    .filter((r) => r.task === task.id && r.evaluator !== def.id);
  const parts = ['## OSが記録した検証実績（機械記録。実行者の自己申告ではない）'];
  // 信用の境界を機械の側から明示する。ここを曖昧にすると判定者は全部を疑い、
  // 決定的記録（OS自身がコマンドを実行して書いた行）まで毎回再導出する。
  // 実測: T017・T019・T020の判定3本はいずれも node --test / regression / docs-drift を
  // 自分で回し直し、3本とも記録と一致した。**再実行から生まれた指摘は0件**である
  // （n=3。だからここでは再実行を禁じず、再実行が要る条件を機械の側で示す）。
  parts.push('');
  parts.push('**信用の境界**: 下の記録のうち `provenance=deterministic` の行は、');
  parts.push('OS自身がコマンドを実行して書いたものであり、実行者は書き換えられない');
  parts.push('（外部からの deterministic 名乗りはコアが拒否する）。');
  parts.push('**事実として信用してよい** — いつ・どのコマンドが・どの終了コードと出力を返したか。');
  parts.push('ただし記録が語らないことが3つある:');
  parts.push('');
  parts.push('1. **その時刻の状態のことしか語らない。** 下の各行には鮮度を付けた。');
  parts.push('   「古い」と付いた記録は、その後に成果物が変わっている（再実行して確かめること）');
  parts.push('2. **実行された検査の範囲しか語らない。** 検査対象は「リポジトリの目次」節の');
  parts.push('   evaluator定義（argv・checks数）で確認できる。範囲外は自分で見るしかない');
  parts.push('3. **「だから要件を満たす」は含まれていない。** 終了コード0は要件充足の証拠ではない。');
  parts.push('   実装が要件どおりかを判断するのがあなたの仕事であり、そこにトークンを使うこと');
  parts.push('');
  parts.push('実行者が書いた散文（完了報告の本文）は、これまでどおり証拠として扱わない。');
  if (!rows.length) {
    parts.push('');
    parts.push('**このタスクで記録されたverdictは0件**。');
    parts.push('報告に検証の主張（テスト通過・lint通過・動作確認等）があっても、OS側に裏付けは無い。');
    parts.push('報告本文に添えられたコマンドと出力だけを証跡として扱い、足りなければ UNCERTAIN とせよ。');
    parts.push('');
    return parts;
  }
  parts.push('');
  // 判定者に要るのは「いまどうなっているか」と「判定が動いたか」であって、
  // 実行のたびに積み上がる全履歴ではない。evaluatorごとに最新の1件だけをevidence付きで出し、
  // 過去は verdict の並び1行に畳む。実測: 6回evaluateを回したタスクでこの節は3,951トークンに
  // 膨れ、briefing全体の66%を占めていた（しかも実行のたびに増え続ける）
  const byEvaluator = {};
  for (const r of rows) (byEvaluator[r.evaluator] = byEvaluator[r.evaluator] || []).push(r);
  // 鮮度は最後の成果物登録との時刻比較で決まる（申告ではない）。
  // 同一状態スキップ・矛盾の判定と同じ基準を使う
  const artifactTs = lastArtifactTs(task);
  for (const evId of Object.keys(byEvaluator).sort()) {
    const list = byEvaluator[evId];
    const last = list[list.length - 1];
    const ev = (last.evidence || []).map((e) => String(e).replace(/\s+/g, ' ').slice(0, 160));
    const fresh = !artifactTs || String(last.ts || '') > artifactTs
      ? '現在の成果物への検査'
      : `**古い**（この記録の後に成果物が変わっている: ${artifactTs}）`;
    parts.push(`- ${evId}: ${last.verdict}（provenance=${last.provenance}, ${last.ts}, ${fresh}）`);
    for (const e of ev.slice(0, 3)) parts.push(`  - ${e}`);
    if (list.length > 1) {
      // 判定が動いた事実は落とさない。往復していれば、それ自体が判定材料である
      parts.push(`  - これまでの推移（${list.length}回）: ${list.map((r) => r.verdict).join(' → ')}`);
    }
  }
  parts.push('');
  return parts;
}

// 実装として扱う拡張子。llm_judgeに文書だけを渡すと、判定者は「作業そのもの」ではなく
// 「作業についての文章」を読むことになり、実装の欠陥は原理的に検出できない
// （報告の内部整合はすべて通ってしまう）。この分類はその穴を可視化するためにある。
const IMPLEMENTATION_EXTS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.rb', '.go',
  '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.scala', '.m',
  '.sh', '.bash', '.ps1', '.sql', '.r', '.jl', '.ipynb',
]);

function looksLikeImplementation(p) {
  return IMPLEMENTATION_EXTS.has(path.extname(String(p)).toLowerCase());
}

function dirHasImplementation(dir, depth = 3) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (e.isFile() && looksLikeImplementation(e.name)) return true;
    if (e.isDirectory() && depth > 0 && dirHasImplementation(path.join(dir, e.name), depth - 1)) {
      return true;
    }
  }
  return false;
}

// タスクのartifactに実装が含まれるか。相対パスは repo_dirs → work_dir → .os の親 の順に解決する。
function artifactsIncludeImplementation(osDir, task) {
  const bases = [];
  for (const d of Object.values((task && task.repo_dirs) || {})) bases.push(d);
  if (task && task.work_dir) bases.push(task.work_dir);
  bases.push(path.dirname(osDir));
  for (const a of (task && task.artifacts) || []) {
    const p = String((a && a.path) || '');
    if (!p) continue;
    if (looksLikeImplementation(p)) return true;
    const candidates = path.isAbsolute(p) ? [p] : bases.map((b) => path.resolve(b, p));
    for (const full of candidates) {
      try {
        if (fs.statSync(full).isDirectory() && dirHasImplementation(full)) return true;
      } catch {
        // 存在しないパスは無視する（artifactの実在検査はここの責務ではない）
      }
    }
  }
  return false;
}

// この評価器がこのタスクを最後に判定した時刻（llm/human判定のみ。replayは状態を見ていない）。
// 無ければ null。
function lastJudgedTs(osDir, taskId, evId) {
  const rows = readJsonl(verdictLog(osDir)).filter(
    (r) => r.task === taskId && r.evaluator === evId && (r.provenance === 'llm' || r.provenance === 'human')
  );
  return rows.length ? rows[rows.length - 1].ts : null;
}

// 成果物をパスごとに1件へ畳む（最新の登録を採る）。同じファイルを修正のたびに再登録すると
// briefingに同じパスが何度も並び、判定者は毎回それを読み直す。読ませたいのは
// 「いま何があるか」と「前回の判定以降に何が変わったか」であって、登録の履歴ではない。
function foldArtifacts(task, sinceTs) {
  const byPath = {};
  for (const a of task.artifacts || []) {
    const cur = byPath[a.path];
    if (!cur || String(a.ts || '') >= String(cur.ts || '')) byPath[a.path] = a;
  }
  return Object.keys(byPath).sort().map((p) => ({
    ...byPath[p],
    changed: !!(sinceTs && String(byPath[p].ts || '') > String(sinceTs)),
  }));
}

// fullContext: 旧方式（context_queriesの結果全文をJSONで埋め込む）。A/B実験のbaseline用に残す。
// 既定は buildReasoningContext による最小Subgraph（CONCEPTv2 §8）。
function prepareLlmJudge(osDir, def, { task, artifacts, fullContext = false, sinceTs } = {}) {
  const parts = [];
  parts.push(`# 独立評価依頼: ${def.id}`);
  parts.push('');
  parts.push('あなたは独立評価者である。生成エージェントの会話履歴・自己申告は一切参照せず、');
  parts.push('このbriefingに含まれる情報と、ここに列挙されたファイルの実物のみで判定せよ。');
  parts.push('');
  parts.push(`## 対象タスク: ${task.id}`);
  parts.push(`Objective: ${task.objective}`);
  parts.push('');
  const folded = foldArtifacts(task, sinceTs);
  const changed = folded.filter((a) => a.changed);
  parts.push('## Artifact');
  if (sinceTs) {
    parts.push(`前回この評価器が判定したのは ${sinceTs}。`
      + (changed.length
        ? `それ以降に変わったのは ${changed.length} 件（下の★）。まずそこを見よ — ただし判定は成果物全体に対して行う`
        : 'それ以降に変わった成果物は無い'));
    parts.push('');
  }
  for (const a of folded) {
    parts.push(`- ${a.changed ? '★ ' : ''}${a.path}${a.note ? ` — ${a.note}` : ''}`);
  }
  if (artifacts && artifacts.length) for (const a of artifacts) parts.push(`- ${a}`);
  parts.push('');
  // 実装が評価に渡っているかを明示する。渡っていないことを知らせないと、判定者は
  // 文書だけを読んでPASSを出し、実装の欠陥はどの評価器も検出しないまま完了扱いになる。
  if (artifactsIncludeImplementation(osDir, task)) {
    parts.push('**このArtifactには実装が含まれる。報告の記述を証拠として採らず、');
    parts.push('主張が実装と一致しているかを実物のコードで確かめること。**');
  } else {
    parts.push('**注意: このArtifactには実装（ソースコード）が含まれていない。**');
    parts.push('したがって、実装が主張どおりかをこのbriefingから検証することはできない。');
    parts.push('実装の正しさに依存するrubric項目は、PASSではなく');
    parts.push('UNCERTAIN（reason: insufficient_evidence）とすること。');
  }
  parts.push('');
  // 報告の「検証しました」は自己申告であり、それ自体は証跡にならない。
  // OSが機械記録したverdictを判定材料として同梱し、申告と記録の突合を可能にする（c-001）。
  parts.push(...recordedVerificationSection(osDir, task, def));
  // 事前固定した手順が結果を見た後に変わっていないか（B2）。plan.jsはgetTaskのために
  // このモジュールを参照するので、循環を避けて呼ぶ時点でrequireする。
  parts.push(...require('./plan').plansSection(osDir, task.id));
  // context_queriesは常に空paramsで呼ばれていたため、横断タスクでも絞り込みが効かなかった。
  // タスクの対象リポジトリをscopeとして渡す（カンマ区切りはOR = 触る全リポジトリの和集合）。
  const queryParams = {};
  const taskScopes = Object.keys(task.repo_dirs || {});
  if (taskScopes.length) queryParams.scope = taskScopes.join(',');
  if (fullContext) {
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
  } else {
    // 最小Subgraphだけを渡す。無関係なStatementを大量に混ぜると、判定者は
    // 「関係ありそうな記述」を探して読むことになり、rubricへの集中が落ちる（§8）
    const ctx = buildReasoningContext(osDir, {
      task,
      evaluator: def,
      // evaluatorごとの予算上書き（不正値は黙って既定に戻す。文字列が混ざったまま
      // 比較に使うと切り詰めが静かに壊れる）
      maxTokens: typeof def.context_max_tokens === 'number' && def.context_max_tokens > 0
        ? def.context_max_tokens
        : undefined,
      queryParams,
    });
    parts.push(...ctx.lines);
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
    reason: '(判定できない/届かない場合) insufficient_evidence | insufficient_sample | model_limitation | conflicting_evidence',
    tokens: 0,
  }, null, 1));
  parts.push('```');
  const file = path.join(osDir, 'briefings', `eval-${task.id}-${def.id}.md`);
  const text = parts.join('\n') + '\n';
  atomicWriteFile(file, text);
  // コンテキスト消費の実測（A1）。Token Ledgerの自己申告と違い、これは実際に生成した
  // briefingの大きさなので、Context削減の主張をここだけで検証できる。
  appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
    ts: nowIso(),
    kind: 'briefing',
    task: task.id,
    evaluator: def.id,
    tokens_est: estimateTokens(text),
  });
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
  // タスク類型（1行の抽象）。同種のタスクの再来を検出し、過去の経験を黙っていても
  // 届けるための鍵。fingerprintの計算はtaskclass側に寄せる（decisionのsituationと同じ規則）
  if (extra.class) {
    entry.class = extra.class;
    entry.class_fp = require('./taskclass').classFingerprint(extra.class);
  }
  // 由来（F005 A-3）: 何がこの仕事を要求したか（agenda:… / failure:F00x / lesson:S00xx / user）。
  // 「指示なしの推進」を主張可能にする唯一の機械記録。
  //
  // 申告のままでは、任意の文字列を書くだけで自発的推進の証拠になってしまう（sc-007の穴）。
  // OS由来を名乗るなら、名指しされた項目が台帳に実在することをここで解決し、
  // 解決結果をタスクに焼き込む（後でその項目が解決・消滅しても、要求された事実は残る）。
  // 解決できない由来は**登録時に失敗させる** — evaluatorの実行先が決まらないときと同じ規律で、
  // 誤った記録を残すより登録を止める方が安全である。
  if (extra.origin) {
    entry.origin = extra.origin;
    const res = require('./agenda').resolveOrigin(osDir, extra.origin);
    if (res && !res.resolved) {
      throw new Error(
        `由来を解決できない: ${extra.origin} — ${res.why}。` +
        '実在する項目を指すか、--origin user（指示された仕事）と書くこと'
      );
    }
    if (res && res.resolved && res.self_directed) {
      entry.origin_verified = { kind: res.kind, ref: res.ref, via: res.via, ts: entry.ts };
    }
  }
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
// 成果物を1件追記する。tsを残すのは「事前に固定したのか、結果を見た後に書いたのか」を
// 台帳から判定するためで、briefingの差分表示（前回の判定以降に何が変わったか）も同じtsを使う。
// tsを引数で受けるのはテスト用（既定は現在時刻）。
function addArtifact(osDir, taskId, { path: p, note, ts } = {}) {
  if (!p) throw new Error('pathが必要');
  const t = getTask(osDir, taskId);
  const artifacts = [...(t.artifacts || []), {
    path: String(p),
    note: note ? String(note) : '',
    ts: ts || nowIso(),
  }];
  return updateTask(osDir, taskId, { artifacts });
}

// 誤登録したタスクの取り下げ（F013）。status は open|done しかなく、登録時の誤りで
// 作られたタスクは評価も完了もされないまま残り、警告を恒久点灯させるだけでなく
// **成長の系列に「試行」として並んで自己測定を汚す**（実測: T018）。
//
// **何かが行われたタスクは取り下げられない。** 成果物かverdictが1件でもあれば、
// それは「誤登録」ではなく「やった仕事」であり、消せる経路を作れば失敗の隠蔽に使える。
// 理由の記録は必須で、取り下げても台帳からは消えない（追記のみ）。
function withdrawTask(osDir, id, reason) {
  if (!reason) throw new Error('取り下げには --reason が必要（なぜ誤登録だったか）');
  const t = getTask(osDir, id);
  if (t.status === 'withdrawn') throw new Error(`${id} は既に取り下げ済み`);
  const artifacts = (t.artifacts || []).length;
  const verdicts = readJsonl(verdictLog(osDir)).filter((r) => r.task === id).length;
  if (artifacts || verdicts) {
    throw new Error(
      `${id} は取り下げられない（成果物${artifacts}件・verdict${verdicts}件）。`
      + '何かが行われたタスクは誤登録ではない。完了させるか、未達のまま残すこと'
    );
  }
  return updateTask(osDir, id, { status: 'withdrawn', withdrawn_reason: String(reason) });
}

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
  // 決定的な検査を先に全部走らせてから、llm_judgeのbriefingを組む。
  // 宣言順のまま回すと、判定者に渡す「検証実績」には**このrunより前の記録**が入る
  // （evaluatorリストで判定者より後ろにいる検査は、briefing生成の時点でまだ再実行されていない）。
  // 実測: その状態のbriefingは8行すべてが「古い」になり、判定者は全検査を自分で回し直した
  // ——鮮度ラベルを付けても、記録が古ければ再実行は正しい振る舞いであり、削減は起きない。
  // 決定的検査はトークンを消費しないので、順序を入れ替えるだけで判定者に現在の記録を渡せる。
  const order = [...task.evaluators].sort((a, b) => {
    const isJudge = (id) => {
      try {
        return loadEvaluatorDef(osDir, id).method === 'llm_judge' ? 1 : 0;
      } catch {
        return 0; // 定義が読めないものはcheckAll側で報告される。順序では前に置く
      }
    };
    return isJudge(a) - isJudge(b);
  });
  for (const evId of order) {
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
        // 同じ状態を二度判定させない。前回の判定以降に成果物が1件も変わっていないなら、
        // 新しいbriefingは前回と同じものになり、判定者の探索（1本あたり数万トークン）が
        // まるごと無駄になる。成果物を1件でも登録すれば再び生成される
        const sinceTs = lastJudgedTs(osDir, taskId, evId);
        const changed = sinceTs
          ? foldArtifacts(task, sinceTs).filter((a) => a.changed)
          : foldArtifacts(task).slice(0, 1);
        if (sinceTs && !changed.length) {
          // 止めた事実を台帳に残す。節約を主張する装置が節約の実績を記録しないと、
          // 何本の判定（実測1本45k〜128kトークン）を止めたかが数えられず、
          // 「この経路を実際に通した」という申告も独立監査が裏づけられない
          // （T017の監査で申告2件がinsufficientになった直接の原因）
          appendJsonl(path.join(osDir, 'observations', 'context_log.jsonl'), {
            ts: nowIso(),
            kind: 'briefing_skipped',
            task: taskId,
            evaluator: evId,
            since: sinceTs,
            tokens_est: 0,
          });
          results.push({
            evaluator: evId,
            method: def.method,
            pending: false,
            skipped: 'unchanged',
            why: `前回の判定（${sinceTs}）以降に成果物が変わっていない。`
              + '同じ状態を再判定しても結果は変わらないため、briefingを生成しない。'
              + '直したら task artifact で登録してから再実行すること',
          });
          continue;
        }
        const briefing = prepareLlmJudge(osDir, def, { task, sinceTs });
        // 宣言されているだけで誰も読まない tier は、全部を同じモデルで回すのと同じである。
        // evaluator定義の tier を routing 表に通し、判定者を起こすモデルを指定する
        let model = null;
        try {
          model = require('./routing').modelForTier(require('./schema').loadConfig(osDir), def.tier);
        } catch {
          model = null;
        }
        results.push({
          evaluator: evId,
          method: def.method,
          pending: true,
          briefing,
          tier: def.tier,
          model,
        });
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
    // fail_reason宣言（F005 A-1）: 検出器が「入力が足りず原理的に届かない」を表現できるようにする。
    // insufficient_sampleのFAILはnext-actionでFIXでなくCOLLECT_EVIDENCEへ写る —
    // 「直せ」ではなく「日を重ねて測れ」が正しい指示である基準（sc-005等）のための経路
    if (r.verdict === 'FAIL' && !r.reason && def.fail_reason && REASONS.includes(def.fail_reason)) {
      r.reason = def.fail_reason;
    }
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

// evaluatorごとのverdict履歴（記録順）。「同じevaluatorが2回続けてUNCERTAIN」
// 「PASS→FAIL→PASSと揺れている」のような、最新1件では見えない状態を判定するために使う。
function verdictHistory(osDir, taskId) {
  const hist = {};
  for (const r of readJsonl(verdictLog(osDir))) {
    if (r.task !== taskId) continue;
    (hist[r.evaluator] = hist[r.evaluator] || []).push(r);
  }
  return hist;
}

// このタスクで最後に成果物が登録された時刻。「いまの状態」の起点であり、
// 同一状態スキップ（llm_judge）と矛盾の判定が同じ基準を使う。
function lastArtifactTs(task) {
  let last = '';
  for (const a of (task && task.artifacts) || []) {
    const ts = String(a.ts || '');
    if (ts > last) last = ts;
  }
  return last || null;
}

// 同じ状態を見た判定どうしの食い違い（F012）。判定の並びだけを見ると、
// run-task 手順6が指示する FAIL → 修正 → PASS が「往復」と読まれ、正直に是正した
// タスクほど完了に到達できなくなる（実測: T016は全判定の直前に成果物の再登録があり、
// 同一状態での食い違いは0件なのに RESOLVE_CONFLICT から出られなかった）。
//
// 対象は「最後の成果物登録以降に記録された llm/human の判定」に限る:
//   - 成果物が変わった後の判定は、前の状態への判定と比べても矛盾ではない
//   - deterministic は判断ではなく再測定である。入力（台帳）が育って結果が変わるのは
//     矛盾ではなく新しい観測で、しかも最新FAILは detFail が拾うため取りこぼさない
//   - 同じ状態のまま判定を引き直してPASSを得ても、食い違ったFAILは同じ範囲に残るので
//     矛盾は消えない（矛盾の「解消」を自己申告で宣言させる経路は作らない）
function sameStateConflict(rows, sinceTs) {
  const current = rows.filter(
    (r) => (r.provenance === 'llm' || r.provenance === 'human')
      && (!sinceTs || String(r.ts || '') > sinceTs)
  );
  const seq = current.map((r) => r.verdict).filter((v) => v !== 'UNCERTAIN');
  if (!seq.includes('PASS') || !seq.includes('FAIL')) return null;
  return seq;
}

// escalation シグナルの検出（B3）。config.routing.escalation は宣言されているだけで
// どのコードも読んでいなかった。next-action が実際に読むことで、
// 「いつ高いモデルに逃がすか」が自己申告ではなく記録から決まるようになる。
function escalationSignals(osDir, task, hist) {
  const taskId = task.id;
  const sinceTs = lastArtifactTs(task);
  const signals = [];
  const evidence = [];
  for (const [evId, rows] of Object.entries(hist).sort()) {
    const last2 = rows.slice(-2);
    if (last2.length === 2 && last2.every((r) => r.verdict === 'UNCERTAIN')) {
      signals.push('uncertain_verdict');
      evidence.push(`${evId}: UNCERTAINが2回連続（${last2.map((r) => r.ts).join(' → ')}）`);
    }
    const seq = sameStateConflict(rows, sinceTs);
    if (seq) {
      signals.push('conflicting_evidence');
      evidence.push(
        `${evId}: 同じ状態への判定が食い違っている（${seq.join(' → ')}）。`
        + `この範囲は最後の成果物登録${sinceTs ? `（${sinceTs}）` : '（成果物の登録なし）'}以降`
      );
    }
  }
  // 直近のfeedbackが既知パターンに当たらない＝過去の資産では説明できない失敗。
  // 台帳には照合結果を保存していないので、報告時と同じ規則で引き直す
  // （同じfingerprintで implemented まで到達したFailureが存在するか）。
  const byId = require('./failure').loadFailures(osDir);
  const solved = new Set(Object.values(byId)
    .filter((f) => f.state === 'implemented').map((f) => f.fingerprint).filter(Boolean));
  const open = Object.values(byId)
    .filter((f) => f.task === taskId && !['implemented', 'accepted_risk'].includes(f.state))
    .sort((a, b) => (a.reported_ts || a.ts) < (b.reported_ts || b.ts) ? -1 : 1);
  const lastF = open[open.length - 1];
  if (lastF && !solved.has(lastF.fingerprint)) {
    signals.push('unknown_fingerprint');
    evidence.push(`${lastF.id}: 未知のfingerprint（対策済みのFailureに同じ症状が無い）`);
  }
  return { signals: [...new Set(signals)], evidence };
}

// Next Action Engine（設計原則§11）。決定的FAILはLLM判定で覆せない。
// 対象evaluatorは task.evaluators と verdict記録済みevaluatorの和集合 —
// 評価後にevaluatorを外しても、記録済みFAILは視界から消えない。
function nextAction(osDir, taskId) {
  const task = getTask(osDir, taskId);
  const latest = latestVerdicts(osDir, taskId);
  const latestDet = latestDeterministicVerdicts(osDir, taskId);
  const hist = verdictHistory(osDir, taskId);
  const evaluators = [...new Set([...(task.evaluators || []), ...Object.keys(latest)])];
  const detail = [];
  const missing = [];
  for (const evId of evaluators) {
    if (!latest[evId]) missing.push(evId);
    else detail.push(latest[evId]);
  }
  let action;
  let why;
  // insufficient_sample =「やり方を変えれば届く」ではなく「入力が足りず原理的に届かない」。
  // FIX（直せ）と写すと、直しようのないものを直させ続けることになる（E3）。
  const underpowered = detail.find((v) => v.reason === 'insufficient_sample');
  const isReal = (v) => v.verdict === 'FAIL' && v.reason !== 'insufficient_sample';
  const detFail = Object.values(latestDet).find(isReal)
    || detail.find((v) => v.provenance === 'deterministic' && isReal(v));
  const anyFail = detail.find(isReal);
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
  } else if (underpowered) {
    action = 'COLLECT_EVIDENCE';
    why = `検出力不足: ${underpowered.evaluator}（現在の入力では原理的に届かない。手法の作り直しではなく、標本・観測の追加が要る）`;
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
  // escalation（B3）。DONEには昇格をかけない — 全PASSの状態から「もっと高いモデルで
  // 見直せ」と言うのは、記録ではなく不安に基づく指示になる。
  const esc = escalationSignals(osDir, task, hist);
  let escalation = null;
  if (esc.signals.length) {
    let cfg = null;
    try { cfg = require('./schema').loadConfig(osDir); } catch { cfg = null; }
    const rec = require('./routing').recommendTier(cfg, { purpose: 'next-action', signals: esc.signals });
    escalation = { signals: esc.signals, evidence: esc.evidence, tier: rec.tier, model: rec.model, why: rec.reason };
  }
  // FIXは昇格で上書きしない（直すべきFAILを昇格で覆い隠すと、欠陥が視界から消える）。
  // 同じ状態への判定の食い違いだけはDONEも上書きする — 同じ評価器が同じ状態にPASSとFAILを出したなら、
  // どちらかの判定が誤っている。最新のPASSを採ると、覆った理由を調べずに完了になる。
  if (escalation && action !== 'FIX') {
    if (esc.signals.includes('conflicting_evidence')) {
      action = 'RESOLVE_CONFLICT';
      why = `同じ状態への判定が食い違っている: ${esc.evidence.filter((e) => e.includes('食い違')).join(' / ')}`;
    } else if (action === 'DONE') {
      // 全PASSの状態から「もっと高いモデルで見直せ」と言うのは、記録ではなく不安に基づく指示
    } else if (esc.signals.includes('uncertain_verdict')) {
      action = 'DEEP_RESEARCH';
      why = `同じevaluatorがUNCERTAINを繰り返している: ${esc.evidence.filter((e) => e.includes('UNCERTAIN')).join(' / ')}`;
    } else if (action === 'INVESTIGATE' || esc.signals.includes('unknown_fingerprint')) {
      action = 'INVESTIGATE';
      escalation.escalate = true;
      why = `${why}（未知のfingerprintのFailureが未消化: ${esc.evidence.filter((e) => e.includes('fingerprint')).join(' / ')}）`;
    }
  }
  // statusは常に最新のactionに従う（一度doneでも新たなFAILでopenに戻る）
  updateTask(osDir, taskId, { status: action === 'DONE' ? 'done' : 'open', last_action: action });
  const result = { task: taskId, action, why, verdicts: detail, missing };
  if (escalation) result.escalation = escalation;
  // DONEは「このタスクのevaluatorが全てPASS」であって「Goalが測れている」ではない。
  // 接地していない成功基準・制約をcaveatsとして必ず添え、完了報告に明示させる。
  if (action === 'DONE') {
    const caveats = unmeasuredCriteria(osDir);
    // 判定器の弱体化はDONEの意味を静かに変える（F014）。登録時の警告を見落としても、
    // 完了を名乗る地点では必ず開示される。「全PASS」が何の全PASSなのかを添える
    try {
      const drift = require('./taskclass').evaluatorDrift(osDir, {
        classFp: task.class_fp,
        evaluators: task.evaluators,
        excludeTaskId: task.id,
      });
      for (const d of drift) {
        caveats.push(
          `評価器 ${d.evaluator} は同じ類型の過去タスク（${d.tasks.join(', ')}）では`
          + '判定させていたが、このタスクでは宣言していない。'
          + '全PASSはこの評価器を除いた範囲での全PASSである'
        );
      }
    } catch {
      // 類型が無いタスク・台帳未整備でも完了判定そのものは止めない
    }
    if (caveats.length) result.caveats = caveats;
  }
  return result;
}

// goal.yamlのsuccess_criteria/constraintsのうち、判定器が無い（MISSING）か
// 一度も実行されていない（UNVERIFIED）もの。Gap Analysisの criteria-only と同じ判定。
function unmeasuredCriteria(osDir) {
  let analysis;
  try {
    analysis = require('./gap').gapAnalysis(osDir, { criteriaOnly: true });
  } catch {
    return []; // goal.yaml未整備でも完了判定そのものは止めない
  }
  // 「測れていない」と「測った結果、不合格」を同じ語で呼ばない。
  // 実測した瞬間に未達が caveats から消えると、目的未達のまま完全なDONEに見える（F005/F010）
  return analysis.required
    .filter((r) => ['MISSING', 'UNVERIFIED', 'UNMET'].includes(r.classification))
    .map((r) => (r.classification === 'UNMET'
      ? `${r.id}「${r.body}」は測定した結果、現在不合格である（UNMET: ${r.why}）`
      : `${r.id}「${r.body}」は現在測定できていない（${r.classification}: ${r.why}）`));
}

module.exports = {
  VERDICTS,
  EVALUATOR_KINDS,
  loadEvaluatorDef,
  listEvaluators,
  validateEvaluatorDef,
  runDeterministic,
  runCommand,
  prepareLlmJudge,
  artifactsIncludeImplementation,
  recordVerdict,
  loadTasks,
  getTask,
  newTask,
  updateTask,
  addTaskNote,
  withdrawTask,
  addArtifact,
  evaluateTask,
  latestVerdicts,
  nextAction,
  unmeasuredCriteria,
};
