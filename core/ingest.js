'use strict';
// 決定的なリポジトリ観測（LLMゼロ）。設計原則§19「通常の更新: event → deterministic update」。
// Statement idを内容ハッシュから導出することで再実行は冪等になる。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { sha1, nowIso, readTextFile } = require('./util');
const { parseYaml } = require('./yaml');
const { assertStatements, loadEvents } = require('./store');

const SKIP_DIRS = new Set(['.git', '.os', 'node_modules', '.claude', 'dist', 'build', '__pycache__']);
const MAX_FILES = 20000;

// 「エージェント向け作業規約」としてファイル名だけで判別できるもの。内容を読まずに名前で決めるため
// 決定的（LLMゼロ）に列挙できる。領域固有の正本ドキュメント（評価憲法・設計正本など）はファイル名から
// 判別できないので、ここでは拾わず doc_clusters として人に問う材料にする。
// ルート直下だけを見るもの（ネストまで探すと依存ライブラリの同名ファイルを大量に拾う）
const ROOT_RULE_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.cursorrules',
  '.clinerules',
  '.github/copilot-instructions.md',
];
// サブディレクトリまで探すもの（エージェント専用の規約ファイルはネストしていても本人が書いたもの）
const NESTED_RULE_FILES = ['CLAUDE.md', 'AGENTS.md'];
// ベンダリング・生成物・ワークツリー複製。ここにある同名ファイルは他人の規約であって取込対象ではない
const NOT_OURS_DIRS = new Set([
  '.git', '.os', '.claude', 'node_modules', 'vendor', 'Pods', 'dist', 'build', 'target',
  '.next', '.venv', '__pycache__', 'third_party', 'coverage',
]);
// doc_clusters の出力上限（1 scopeあたり）。全件列挙は判断材料にならないため件数順に絞る
const MAX_DOC_CLUSTERS = 5;

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.gitattributes') continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        files.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  }
  return files.sort();
}

function git(repoRoot, args) {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').trim();
}

function obsStatement(kind, body, ts, scope) {
  const key = scope ? `${scope}\n${kind}` : kind;
  const st = {
    id: `obs-${sha1(`${key}\n${body}`).slice(0, 10)}`,
    ts,
    type: 'observation',
    body,
    status: 'fact',
    tags: ['repo', kind],
    provenance: { source: 'ingest-repo', method: 'deterministic' },
  };
  if (scope) st.scope = [scope];
  return st;
}

// 「同じ観測対象の世代」を (scope, series) で引く索引。scopeを混ぜないことが多リポジトリ横断の
// 前提である: 別リポジトリの同種観測を互いに打ち消してはならない（scope未設定の旧世代は '' キー）。
// match(e) が真の現在Statementだけを対象にし、seriesOf(e) がその系列キーを返す。
function latestBySeries(events, match, seriesOf) {
  const superseded = new Set(events.filter((e) => e.supersedes).map((e) => e.supersedes));
  const latest = {};
  for (const e of events) {
    if (superseded.has(e.id)) continue;
    if (!match(e)) continue;
    const series = seriesOf(e);
    if (series) latest[`${(e.scope || []).join(',')}|${series}`] = e.id;
  }
  return latest;
}

// 内容ハッシュ由来のidで冪等・内容変化時は旧世代をsupersedeという共通規律を1箇所に集約する。
function makeSuperseder(events, latest, scope) {
  const known = new Set(events.map((e) => e.id));
  const scopeKey = scope || '';
  return (st, series) => {
    const prev = latest[`${scopeKey}|${series}`];
    if (!prev) return st; // 初回
    if (prev === st.id) return null; // 内容不変 → 追記不要
    if (known.has(st.id)) {
      // 過去と同一内容への回帰でidが衝突する場合は世代を混ぜて別idにする
      const [prefix] = st.id.split('-');
      st.id = `${prefix}-${sha1(`${series}\n${st.body}\n${prev}`).slice(0, 10)}`;
    }
    st.supersedes = prev;
    return st;
  };
}

// 1行に畳んで空白を正規化する（Statement bodyは1件1主張の短文が原則）
function flatten(text) {
  return text.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

// 見出し（# 〜 ####）で本文を分割する。sectionは「見出し行 + 次の見出しまでの本文」。
function splitByHeading(text) {
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,4})\s+(.+?)\s*$/.exec(l);
    if (m) heads.push({ i, level: m[1].length, title: m[2] });
  });
  const sections = [];
  for (let k = 0; k < heads.length; k++) {
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    const content = lines.slice(heads[k].i + 1, end).join('\n');
    sections.push({ title: heads[k].title, level: heads[k].level, content });
  }
  return sections;
}

// frontmatter（--- で囲まれたYAML）を読む。例外を投げず {front, error} で返す。
// 1件の不正で取込全体がabortすると、健全な残り全部が失われる（実運用で121件中3件の不正により
// 全体が停止した）。壊れたファイルは「取り込めなかった」と申告してスキップするのが正しい。
// frontmatterが無いこと自体は不正ではない（error=null, front=null）。
function readFrontmatter(abs) {
  let text;
  try {
    text = readTextFile(abs);
  } catch (e) {
    return { front: null, error: `ファイルを読めない: ${e.message}` };
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { front: null, error: null };
  let front;
  try {
    front = parseYaml(m[1]);
  } catch (e) {
    return { front: null, error: `frontmatterを解析できない: ${e.message}` };
  }
  if (front !== null && (typeof front !== 'object' || Array.isArray(front))) {
    // key: value のマップでないものは索引として読めない（本文がそのまま挟まっている等）
    return { front: null, error: 'frontmatterがマップではない' };
  }
  return { front: front || {}, error: null };
}

// リポジトリの作業規約ドキュメント（CLAUDE.md / AGENTS.md 等）を見出し単位のplaybook
// Statementとして取り込む。LLMを使わない決定的変換（設計原則§19）。
// 長い節は先頭を要約枠として保持し、全文はファイルパスへのポインタで残す
// （World Modelに本文を丸ごと抱えるとQueryの返却枠を食い潰すため — R002 H2）。
function ingestRuleDocs(osDir, { scope, repoRoot, docs, maxSectionChars = 1200, dryRun = false } = {}) {
  if (!scope) throw new Error('ingestRuleDocsにはscopeが必要（どのリポジトリの規約か）');
  const root = path.resolve(repoRoot || process.cwd());
  const ts = nowIso();
  const events = loadEvents(osDir);
  const isRule = (e) => e.provenance && e.provenance.source === 'ingest-rules';
  const latest = latestBySeries(events, isRule, (e) => e.provenance.series);
  const supersede = makeSuperseder(events, latest, scope);
  const statements = [];
  const missing = [];
  for (const rel of docs || []) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const sections = splitByHeading(readTextFile(abs));
    const seenTitles = {};
    for (const sec of sections) {
      const content = flatten(sec.content);
      if (!content) continue; // 見出しだけの節（章タイトル等）は主張を持たない
      seenTitles[sec.title] = (seenTitles[sec.title] || 0) + 1;
      const dup = seenTitles[sec.title] > 1 ? `#${seenTitles[sec.title]}` : '';
      const series = `rule|${rel}|${sec.title}${dup}`;
      const truncated = content.length > maxSectionChars;
      const shown = truncated ? `${content.slice(0, maxSectionChars)}…` : content;
      const body = `${rel}「${sec.title}」: ${shown}${truncated ? `（全文: ${abs} の「${sec.title}」節）` : ''}`;
      const tags = ['playbook', 'agent-rule'];
      const st = {
        // 派生タグもStatementの内容なのでidハッシュに含める（分類ルールを直したときに
        // 既存Statementが旧タグのまま取り残されず、次のingestで世代交代する）
        id: `rule-${sha1(`${scope}\n${series}\n${body}\n${tags.join(',')}`).slice(0, 10)}`,
        ts,
        type: 'constraint',
        body,
        status: 'fact',
        tags,
        scope: [scope],
        provenance: { source: 'ingest-rules', method: 'deterministic', ref: `${abs}#${sec.title}`, series },
      };
      const withSup = supersede(st, series);
      if (withSup) statements.push(withSup);
    }
  }
  const result = commitOrPreview(osDir, statements, dryRun);
  return { ...result, missing_docs: missing };
}

// Claude Codeの自動メモリ（1ファイル1事実・frontmatter付きMarkdown）の索引を取り込む。
// bodyには frontmatter の description（既に1行に蒸留された主張）だけを入れ、本文は
// ファイルパスのポインタとして残す。83件7万トークンを丸ごと入れるとQueryの返却枠を
// 食い潰すため（R002 H2）、索引だけを資産化して本文は必要時に読む。
// metadata.type は「何の種類の記憶か」であって「作法かどうか」ではない。playbook を feedback だけに
// 限ると、type: project として書かれた運用ルール（例: このリポジトリはmain直pushで開発する）が
// scope絞りのplaybook Queryから構造的に落ちる。メモリ索引はそのプロジェクト固有の前提知識そのもの
// なので全件を playbook 到達対象にし、過剰包含側に倒す（付け忘れは知識を消すが、過剰は読み手が捨てられる）。
const MEMORY_TYPE_MAP = {
  feedback: { type: 'constraint', status: 'fact' },
  project: { type: 'claim', status: 'hypothesis', confidence: 0.5 },
  reference: { type: 'entity', status: 'fact' },
  user: { type: 'claim', status: 'fact' },
};

function ingestMemoryIndex(osDir, { scope, dir, dryRun = false } = {}) {
  if (!scope) throw new Error('ingestMemoryIndexにはscopeが必要（どのリポジトリのメモリか）');
  const base = path.resolve(dir);
  if (!fs.existsSync(base)) return { added: [], skipped: [], warnings: [], missing_dir: base };
  const ts = nowIso();
  const events = loadEvents(osDir);
  const isMem = (e) => e.provenance && e.provenance.source === 'ingest-memory';
  const latest = latestBySeries(events, isMem, (e) => e.provenance.series);
  const supersede = makeSuperseder(events, latest, scope);
  const statements = [];
  const skippedFiles = [];
  const unparsable = [];
  const parseWarnings = [];
  const files = fs.readdirSync(base).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
  for (const f of files) {
    const abs = path.join(base, f);
    const { front, error } = readFrontmatter(abs);
    if (error) {
      // 読めない1件のために健全な残りを捨てない。パスと理由を警告として持ち帰り、人が直せるようにする
      skippedFiles.push(f);
      unparsable.push({ file: f, path: abs, reason: error });
      parseWarnings.push(`${abs}: ${error}`);
      continue;
    }
    const desc = front && front.description ? flatten(String(front.description)) : '';
    if (!desc) {
      // descriptionの無いメモリは1行の主張に蒸留されていない。機械取込の対象外として申告する
      skippedFiles.push(f);
      continue;
    }
    const memType = (front.metadata && front.metadata.type) || 'project';
    const map = MEMORY_TYPE_MAP[memType] || MEMORY_TYPE_MAP.project;
    const name = front.name || path.basename(f, '.md');
    const series = `memory|${name}`;
    const body = `${desc}（詳細: ${abs}）`;
    const tags = ['playbook', 'memory', memType];
    const st = {
      id: `mem-${sha1(`${scope}\n${series}\n${body}\n${tags.join(',')}`).slice(0, 10)}`,
      ts,
      type: map.type,
      body,
      status: map.status,
      tags,
      scope: [scope],
      provenance: { source: 'ingest-memory', method: 'deterministic', ref: abs, series },
    };
    if (map.confidence !== undefined) st.confidence = map.confidence;
    const withSup = supersede(st, series);
    if (withSup) statements.push(withSup);
  }
  const result = commitOrPreview(osDir, statements, dryRun);
  return {
    ...result,
    warnings: [...(result.warnings || []), ...parseWarnings],
    files_seen: files.length,
    skipped_files: skippedFiles,
    // 「descriptionが無い（そもそも索引化対象外）」と「壊れていて読めない（直すべき）」を混ぜない
    unparsable_files: unparsable,
  };
}

// dryRun時は追記せず「追記されるはずだったもの」だけを返す。取込漏れ・更新漏れの検査
// （evaluator repo_knowledge_sync）が、World Modelを変更せずに同期状態を判定できるようにする。
function commitOrPreview(osDir, statements, dryRun) {
  if (!dryRun) return assertStatements(osDir, statements);
  return { added: [], skipped: [], warnings: [], dry_run: true, would_add: statements.map((st) => st.id) };
}

// ---- 知識源の発見（①発見の機械化）--------------------------------------------------
// init時に「体系化された知識がすでに外部に存在するのに登録し忘れる」取りこぼしを、人の記憶では
// なく決定的な列挙で塞ぐ。発見するのは「場所」だけで、取り込むかどうかは人が決める
// （目的の推定はしない — init-osの鉄則）。

// Claude Codeの自動メモリの格納先はプロジェクトの絶対パスから機械的に導かれる（英数字以外を'-'に置換）
function memorySlug(absPath) {
  return String(absPath).replace(/[^A-Za-z0-9]/g, '-');
}

// 実体がファイルかどうか（.clinerules のようにディレクトリとして存在する規約もあるため、
// 名前の一致だけで取込候補にすると ingest rules が読めないパスを候補に出してしまう）
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ネストした規約ファイルを探す（ベンダリング・生成物・ワークツリー複製は他人の規約なので除外）
function findNestedRuleDocs(root, maxDirs = 4000) {
  const items = [];
  const stack = [''];
  let visited = 0;
  while (stack.length && visited < maxDirs) {
    const rel = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (NOT_OURS_DIRS.has(e.name)) continue;
        stack.push(childRel);
      } else if (e.isFile() && rel && NESTED_RULE_FILES.includes(e.name)) {
        items.push(childRel);
      }
    }
  }
  // 打ち切りは黙って隠さない（「全部見た」と読める出力は取りこぼしを追認する）
  return { items: items.sort(), capped: stack.length > 0 };
}

// Markdownの塊をディレクトリ単位で数える。ファイル名から正本性を判定できない領域固有ドキュメント
// （評価憲法・仕様正本など）を人に問うための材料であり、候補そのものではない
function findDocClusters(root, maxDirs = 4000) {
  const counts = {};
  const stack = [''];
  let visited = 0;
  while (stack.length && visited < maxDirs) {
    const rel = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (NOT_OURS_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(childRel);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        counts[rel || '.'] = (counts[rel || '.'] || 0) + 1;
      }
    }
  }
  const items = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_DOC_CLUSTERS)
    .map(([dir, files]) => ({ dir, files }));
  return { items, capped: stack.length > 0, total_dirs: Object.keys(counts).length };
}

// sources（登録済み）・excluded（除外宣言済み）と突き合わせ、候補を3分類して返す。
// undecided が残っている限り「取りこぼしたのか、意図して外したのか」が判別できない状態である。
function discoverKnowledgeSources({ sources = [], excluded = [], home = os.homedir() } = {}) {
  const excludedByPath = new Map(excluded.map((e) => [path.resolve(e.path), e]));
  const candidates = [];
  const docClusters = [];
  const warnings = [];
  const roots = [];
  for (const src of sources) {
    roots.push({ scope: src.scope, repo: path.resolve(src.repo) });
  }
  // グローバルの規約（全セッションに効くのでどのリポジトリの知識でもないが、作法として最上位）
  roots.push({ scope: 'global-rules', repo: path.join(home, '.claude'), global: true });

  const globalRoot = path.join(home, '.claude');
  const seen = new Set();
  for (const root of roots) {
    if (seen.has(root.repo)) continue;
    seen.add(root.repo);
    if (!fs.existsSync(root.repo)) continue;
    // ~/.claude は規約の置き場であって作業リポジトリではない（配下の plugins / projects は
    // 他人のプラグインとキャッシュ）。sourcesに登録された場合もネスト探索の対象にしない
    const isGlobal = root.global || root.repo === globalRoot;
    const src = sources.find((s) => path.resolve(s.repo) === root.repo);
    const registeredDocs = new Set((src && src.rule_docs) || []);
    const rels = [];
    for (const name of ROOT_RULE_FILES) {
      if (isFile(path.join(root.repo, name))) rels.push(name);
    }
    if (!isGlobal) {
      const nested = findNestedRuleDocs(root.repo);
      rels.push(...nested.items);
      if (nested.capped) warnings.push(`${root.scope}: ディレクトリ数の上限で走査を打ち切った（ネストした規約ファイルを見落としている可能性がある）`);
    }
    for (const rel of rels) {
      const abs = path.join(root.repo, rel);
      const ex = excludedByPath.get(abs);
      candidates.push({
        kind: 'rule_doc',
        scope: root.scope,
        repo: root.repo,
        rel,
        path: abs,
        decision: registeredDocs.has(rel) ? 'registered' : ex ? 'excluded' : 'undecided',
        ...(ex ? { reason: ex.reason } : {}),
      });
    }
    // 自動メモリ（パスから機械的に導ける。存在するのに未登録なら取りこぼし）
    const memDir = path.join(home, '.claude', 'projects', memorySlug(root.repo), 'memory');
    let memFiles = 0;
    try {
      memFiles = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
    } catch {
      memFiles = 0;
    }
    if (memFiles > 0) {
      const registered = src && src.memory_dir && path.resolve(src.memory_dir) === memDir;
      const ex = excludedByPath.get(memDir);
      candidates.push({
        kind: 'memory_dir',
        scope: root.scope,
        repo: root.repo,
        path: memDir,
        files: memFiles,
        decision: registered ? 'registered' : ex ? 'excluded' : 'undecided',
        ...(ex ? { reason: ex.reason } : {}),
      });
    }
    if (!isGlobal) {
      const clusters = findDocClusters(root.repo);
      for (const c of clusters.items) {
        docClusters.push({ scope: root.scope, ...c, path: path.join(root.repo, c.dir) });
      }
      if (clusters.total_dirs > clusters.items.length) {
        warnings.push(`${root.scope}: Markdownを含むディレクトリ${clusters.total_dirs}件のうち上位${clusters.items.length}件のみ表示`);
      }
    }
  }
  const undecided = candidates.filter((c) => c.decision === 'undecided');
  return { candidates, undecided, doc_clusters: docClusters, warnings };
}

// 未決定の候補から goal.yaml へ貼れる断片を作る（人が編集する前提の下書き）
function emitSourcesDraft(discovery) {
  const byRepo = new Map();
  for (const c of discovery.undecided) {
    const key = `${c.scope}\t${c.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, { scope: c.scope, repo: c.repo, rule_docs: [], memory_dir: null });
    if (c.kind === 'rule_doc') byRepo.get(key).rule_docs.push(c.rel);
    if (c.kind === 'memory_dir') byRepo.get(key).memory_dir = c.path;
  }
  const lines = ['# sources へ追記する下書き（採否は人が決める。外すものは excluded_sources に理由付きで書く）'];
  for (const v of byRepo.values()) {
    lines.push(`  - scope: ${v.scope}`);
    lines.push(`    repo: ${v.repo}`);
    if (v.rule_docs.length) lines.push(`    rule_docs: [${v.rule_docs.join(', ')}]`);
    if (v.memory_dir) lines.push(`    memory_dir: ${v.memory_dir}`);
  }
  return lines.join('\n');
}

// リポジトリの現状を少数のObservation Statementとして追記する（ファイル毎ではなく要約粒度）。
// 同じ観測kindの内容が変わった場合は旧観測をsupersedesし、矛盾するfactが現在状態に併存しないようにする。
function ingestRepo(osDir, repoRoot, { scope, dryRun = false } = {}) {
  const root = path.resolve(repoRoot || process.cwd());
  const ts = nowIso();
  const statements = [];
  const events = loadEvents(osDir);
  const latest = latestBySeries(
    events,
    (e) => e.type === 'observation' && e.provenance && e.provenance.source === 'ingest-repo',
    (e) => (e.tags || []).find((t) => t !== 'repo')
  );
  const supersede = makeSuperseder(events, latest, scope);
  const withSupersede = (st, kind) => supersede(st, kind);
  const pushObs = (st) => {
    if (st) statements.push(st);
  };

  const files = walk(root);
  const byExt = {};
  for (const f of files) {
    const ext = path.extname(f) || '(none)';
    byExt[ext] = (byExt[ext] || 0) + 1;
  }
  const extSummary = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([e, n]) => `${e}:${n}`).join(', ');
  pushObs(withSupersede(obsStatement('inventory',
    `ファイル構成: 総数${files.length}。拡張子別: ${extSummary}`, ts, scope), 'inventory'));

  const topLevel = [...new Set(files.map((f) => f.split('/')[0]))].sort().join(', ');
  pushObs(withSupersede(obsStatement('layout', `トップレベル構成: ${topLevel}`, ts, scope), 'layout'));

  const log = git(root, ['log', '-n', '20', '--pretty=format:%h %cs %s']);
  if (log) {
    pushObs(withSupersede(obsStatement('git-log', `直近コミット:\n${log}`, ts, scope), 'git-log'));
  }
  const status = git(root, ['status', '--porcelain']);
  if (status !== null) {
    const lines = status ? status.split('\n').length : 0;
    pushObs(withSupersede(obsStatement('git-status', `未コミット変更: ${lines}件`, ts, scope), 'git-status'));
  }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) {
    pushObs(withSupersede(obsStatement('git-branch', `現在ブランチ: ${branch}`, ts, scope), 'git-branch'));
  }

  const result = commitOrPreview(osDir, statements, dryRun);
  return { ...result, file_count: files.length };
}

module.exports = {
  ingestRepo,
  ingestRuleDocs,
  ingestMemoryIndex,
  discoverKnowledgeSources,
  emitSourcesDraft,
  memorySlug,
};
