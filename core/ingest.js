'use strict';
// 決定的なリポジトリ観測（LLMゼロ）。設計原則§19「通常の更新: event → deterministic update」。
// Statement idを内容ハッシュから導出することで再実行は冪等になる。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha1, nowIso } = require('./util');
const { assertStatements, loadEvents } = require('./store');

const SKIP_DIRS = new Set(['.git', '.os', 'node_modules', '.claude', 'dist', 'build', '__pycache__']);
const MAX_FILES = 20000;

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

function obsStatement(kind, body, ts) {
  return {
    id: `obs-${sha1(`${kind}\n${body}`).slice(0, 10)}`,
    ts,
    type: 'observation',
    body,
    status: 'fact',
    tags: ['repo', kind],
    provenance: { source: 'ingest-repo', method: 'deterministic' },
  };
}

// リポジトリの現状を少数のObservation Statementとして追記する（ファイル毎ではなく要約粒度）。
// 同じ観測kindの内容が変わった場合は旧観測をsupersedesし、矛盾するfactが現在状態に併存しないようにする。
function ingestRepo(osDir, repoRoot) {
  const root = path.resolve(repoRoot || process.cwd());
  const ts = nowIso();
  const statements = [];
  // kindごとの最新の既存観測（supersedes済みを除く）
  const events = loadEvents(osDir);
  const superseded = new Set(events.filter((e) => e.supersedes).map((e) => e.supersedes));
  const latestByKind = {};
  for (const e of events) {
    if (e.type !== 'observation' || superseded.has(e.id)) continue;
    if (!e.provenance || e.provenance.source !== 'ingest-repo') continue;
    const kind = (e.tags || []).find((t) => t !== 'repo');
    if (kind) latestByKind[kind] = e.id;
  }
  const withSupersede = (st, kind) => {
    const latest = latestByKind[kind];
    if (!latest) return st; // 初回観測
    if (latest === st.id) return null; // 内容不変 → 追記不要
    // 内容が変化: 旧観測をsupersede。過去と同一内容への回帰でIDが衝突する場合は世代を混ぜる
    if (events.some((e) => e.id === st.id)) {
      st.id = `obs-${sha1(`${kind}\n${st.body}\n${latest}`).slice(0, 10)}`;
    }
    st.supersedes = latest;
    return st;
  };
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
    `ファイル構成: 総数${files.length}。拡張子別: ${extSummary}`, ts), 'inventory'));

  const topLevel = [...new Set(files.map((f) => f.split('/')[0]))].sort().join(', ');
  pushObs(withSupersede(obsStatement('layout', `トップレベル構成: ${topLevel}`, ts), 'layout'));

  const log = git(root, ['log', '-n', '20', '--pretty=format:%h %cs %s']);
  if (log) {
    pushObs(withSupersede(obsStatement('git-log', `直近コミット:\n${log}`, ts), 'git-log'));
  }
  const status = git(root, ['status', '--porcelain']);
  if (status !== null) {
    const lines = status ? status.split('\n').length : 0;
    pushObs(withSupersede(obsStatement('git-status', `未コミット変更: ${lines}件`, ts), 'git-status'));
  }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) {
    pushObs(withSupersede(obsStatement('git-branch', `現在ブランチ: ${branch}`, ts), 'git-branch'));
  }

  const result = assertStatements(osDir, statements);
  return { ...result, file_count: files.length };
}

module.exports = { ingestRepo };
