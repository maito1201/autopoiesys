'use strict';
// 環境診断（doctor）とユーザー固有OS（.os/）の雛形生成（init）。
// initはOSを作らない — 構造だけを置き、中身はヒアリングとBuild Skillが埋める。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWriteFile, readTextFile } = require('./util');
const { FORMAT_VERSION } = require('./schema');

// このOSS Coreのルート（cli/index.jsやskills/の親）
const OSS_ROOT = path.resolve(__dirname, '..');

function doctor() {
  const report = { ok: true, checks: [] };
  const major = parseInt(process.versions.node.split('.')[0], 10);
  report.checks.push({
    name: 'node',
    ok: major >= 20,
    detail: `v${process.versions.node}${major >= 20 ? '' : '（>=20が必要）'}`,
  });
  const gitRes = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  report.checks.push({
    name: 'git',
    ok: !gitRes.error && gitRes.status === 0,
    detail: gitRes.error ? 'git不在（履歴の観測とOSバージョン管理に必要）' : (gitRes.stdout || '').trim(),
  });
  report.checks.push({ name: 'platform', ok: true, detail: `${process.platform} ${process.arch}` });
  report.ok = report.checks.every((c) => c.ok || c.name === 'git');
  return report;
}

const CONFIG_TEMPLATE = `format_version: ${FORMAT_VERSION}
os_version: 1
routing:
  T0: deterministic
  T1: { model: cheap, use_for: [classification, summary, checklist] }
  T2: { model: mid, use_for: [planning, integration] }
  T3: { model: high, use_for: [unknown_problem, critical_failure, contradiction, os_redesign] }
  escalation:
    - uncertain_verdict
    - unknown_fingerprint
    - conflicting_evidence
budgets:
  research_tokens: 200000
strict_vocabulary: false
stale_after_days: 7
regression_every_days: 7
gap_confidence_floor: 0.7
`;

const GOAL_TEMPLATE = `# init-os Skillのヒアリングで生成する。手で書く場合はSCHEMA.md参照。
goal: (ユーザーが達成したい状態を自然文で)
domain: (領域名)
objectives:
  - (目的の分解)
success_criteria:
  - id: sc-001
    statement: (何が起きたら成功か)
    evaluator: unbound
constraints:
  - id: c-001
    statement: (絶対にやってはいけないこと)
    severity: hard
    evaluator: unbound
autonomy:
  escalate_on:
    - (人間に委ねる条件)
optimization:
  - correctness
sources:
  # 知識の取込対象。sources scan で候補を機械的に発見できる（未登録＝取りこぼし）
  - repo: .
    # rule_docs: [CLAUDE.md]          # 作業規約・正本ドキュメント（見出し単位でplaybook化）
    # memory_dir: /abs/path/to/memory # 1ファイル1事実のfrontmatter付きMarkdown索引
excluded_sources:
  # 発見したが取り込まない知識源。reasonは必須（「取りこぼし」と「意図した除外」を区別するため）
  # - path: ./AGENTS.md
  #   reason: CLAUDE.mdと同内容
notes: |
  (ヒアリング原文)
`;

const VOCABULARY_TEMPLATE = `# predicate / tag の登録簿。未登録は警告（strict_vocabulary: trueでエラー）。
# 実績で安定した語彙から登録していく（最初から完璧を目指さない — 設計原則§26⑥）。
predicates:
  - affects
  - depends_on
  # Intelligence Graphの最小集合（各語に決定的な消費者がいる — 残りは需要駆動で追加）
  - requires        # Goal分解の骨格辺（gapが辿る）
  - causes          # Failure診断・因果
  - contradicts     # gapのCONFLICTING判定の入力
  - evaluated_by    # 知性→評価器の束縛（gapのMISSING/UNVERIFIED判定）
  - measured_by     # 知性→メトリクスの束縛
tags:
  - repo
  - inventory
  - layout
  - git-log
  - git-status
  - git-branch
`;

const OS_README = `# .os/ — ユーザー固有Intelligence OS

このディレクトリはautopoiesys OSS Coreが生成・操作するユーザー固有OSである。
形式契約はOSS側のSCHEMA.mdを参照。全状態変化はgit diffで監査できる。
OSS本体とは分離して、このディレクトリ自体を独立にバージョン管理することを推奨する。
`;

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c > 0) {
      let v = line.slice(c + 1).trim();
      // 引用済みの値は中身だけ取り出す（二重引用の防止）
      if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        v = v.slice(1, -1);
      }
      out[line.slice(0, c).trim()] = v;
    }
  }
  return out;
}

// 対象ワークスペースにClaude Code用のスキルスタブ（.claude/skills/）を生成する。
// 正本はOSS側 skills/ にあり、スタブは参照のみ（二重管理を避ける）。
// OSS Coreがワークスペース外にある場合は絶対パスで参照する。
function scaffoldSkillStubs(targetDir) {
  const skillsRoot = path.join(OSS_ROOT, 'skills');
  const created = [];
  const skipped = [];
  if (!fs.existsSync(skillsRoot)) return { created, skipped };
  let ref = path.relative(targetDir, OSS_ROOT).split(path.sep).join('/');
  if (ref.startsWith('..')) ref = OSS_ROOT.split(path.sep).join('/');
  const prefix = ref === '' ? '' : `${ref}/`;
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const canonical = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(canonical)) continue;
    const stub = path.join(targetDir, '.claude', 'skills', entry.name, 'SKILL.md');
    if (fs.existsSync(stub)) {
      skipped.push(entry.name); // 既存スタブ（ユーザーが調整済みの可能性）は上書きしない
      continue;
    }
    const fm = parseFrontmatter(readTextFile(canonical));
    atomicWriteFile(stub, [
      '---',
      `name: ${entry.name}`,
      // JSONの二重引用文字列はYAMLのdouble-quoted scalarとして有効。
      // 説明に「: 」や「#」が入ってもfrontmatterが壊れないようにする。
      `description: ${JSON.stringify(String(fm.description || `${entry.name} skill`))}`,
      '---',
      '',
      `このSkillの正本は \`${prefix}skills/${entry.name}/SKILL.md\` である。まずそれをReadで読み、その手順に厳密に従うこと。`,
      '',
    ].join('\n'));
    created.push(entry.name);
  }
  return { created, skipped };
}

function initOs(targetDir, { force = false } = {}) {
  const osDir = path.join(targetDir, '.os');
  if (fs.existsSync(path.join(osDir, 'config.yaml')) && !force) {
    throw new Error(`.os/ は既に存在する: ${osDir}（上書きは --force）`);
  }
  const dirs = [
    'world_model', 'queries', 'evaluators', 'rules', 'tasks', 'evaluations',
    'failures', 'golden_tasks', 'briefings', 'proposals', 'plugins', 'observations',
  ];
  for (const d of dirs) fs.mkdirSync(path.join(osDir, d), { recursive: true });
  // 既存ファイルは上書きしない。--force での再実行は「不足分の補完と
  // スタブの再生成」であり、調整済みのconfig・語彙・goalを巻き戻す操作ではない。
  const writeIfAbsent = (rel, content) => {
    const p = path.join(osDir, rel);
    if (!fs.existsSync(p)) atomicWriteFile(p, content);
  };
  writeIfAbsent('config.yaml', CONFIG_TEMPLATE);
  writeIfAbsent('goal.yaml', GOAL_TEMPLATE);
  writeIfAbsent(path.join('world_model', 'vocabulary.yaml'), VOCABULARY_TEMPLATE);
  writeIfAbsent('README.md', OS_README);
  const stubs = scaffoldSkillStubs(targetDir);
  return { osDir, created: dirs, skill_stubs: stubs };
}

module.exports = { doctor, initOs, scaffoldSkillStubs };
