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

// 唯一の同梱Query。他のQueryはドメインごとに build-query-system で設計するが、
// decision / outcome はコアの語彙なので、引く手段までコアが用意する。
// これが無いと決定は「書いたが二度と読まれない記録」になり、Decision Modelが
// 事実上ログに退化する（CONCEPT §8 / TODO C2）。
const QUERY_PAST_DECISIONS = `name: get_past_decisions
description: 過去の決定と、そのレビュー結果（met/unmet/unclear）。似た判断をする前に必ず引く。
pipeline:
  - select: { type: decision }
  - where: { status: [fact, hypothesis] }
  # outcomeは derived_from で決定を指す。in方向に辿ると「その決定がどうなったか」が付く
  - expand: { roles: [derived_from], direction: in, limit: 3 }
  - project: [id, body, situation, fingerprint, chosen, options, criteria, expected_outcome, tags, linked]
  - limit: 20
max_tokens: 1500
`;

// 決定の答え合わせ（outcome）を、結果そのものの側から引くQuery。
// get_past_decisions は決定を主語にして outcome を expand で添えるが、
// auditReachability が到達済みに数えるのは**トップレベル行のidだけ**である。
// したがってこれが無いと、decision outcome を1件記録した瞬間に
// 「Queryから引けない事実」が生まれ、wm_reachability が必ず落ちる —
// **学習を前へ進める操作が検査を壊す向きになる。**
// 結果を主語に引く経路には運用上の価値もある: `decision list --unreviewed` はCLIであって
// Queryではないため、これが無いと「どの判断が外れたか」を文脈として実行側へ配れない。
const QUERY_DECISION_OUTCOMES = `name: get_decision_outcomes
description: |-
  過去の決定の答え合わせ（met / unmet / unclear）を、結果そのものの側から引く。
  「どの判断が外れたか」を一覧するとき、方針（policy）の畳み込み条件を確認するときに使う。
  resultで絞れる（例: unmet だけを見て、反証された判断を洗う）。
params:
  result:
    required: false
pipeline:
  - select: { type: outcome }
  - where: { status: [fact, hypothesis] }
  - where_param: { field: result, equals: result }
  - sort: { by: id, order: desc }
  - project: [id, body, decision, result, note, ts]
  - limit: 30
max_tokens: 2500
`;

// 教訓の裏づけ（supports）と反証（counters）。`task consolidate --helped/--misled` が
// type: evidence として書く行で、**どの教訓を今後も配信してよいか**を決める材料である。
// これが無いと、蒸留（学習を前へ進める操作）を1回するだけで到達不能なStatementが生まれ、
// wm_reachability が落ちる — outcome とまったく同じ形の穴だった。
const QUERY_LESSON_EVIDENCE = `name: get_lesson_evidence
description: |-
  教訓の裏づけ（supports）と反証（counters）を新しい順に返す。
  ある教訓を信じてよいかは、それ自体の説得力ではなく実績の積み上がりで決まる。
  linksのroleが supports なら効いた申告、counters なら外れた申告。
  申告は実行者のものであり、experience audit を通るまで検証済みではない。
pipeline:
  - select: { type: evidence }
  - where: { status: [fact, hypothesis] }
  - sort: { by: id, order: desc }
  - project: [id, body, links, status, ts]
  - limit: 40
max_tokens: 2000
`;

// 未解決のUnknown。`gap --assert` が type: unknown として起票する。
// これも同梱しないと、gap分析の結果が「書いたが誰も引けない記録」になる。
const QUERY_OPEN_UNKNOWNS = `name: get_open_unknowns
description: |-
  未解決のUnknown（調査で確定できなかった事項・gap分析が起票した不足）を返す。
  関連領域のタスクに着手する前に確認し、既知の未確定事項を誤って断定しないようにする。
  調査タスクの候補リストでもある。
params:
  tag:
    required: false
pipeline:
  - where: { status: unknown }
  - where_param: { field: tags, contains: tag }
  - sort: { by: id, order: asc }
  - project: [id, body, tags, scope]
  - limit: 20
max_tokens: 2000
`;

// Coreが同梱するQuery。**seed（config/goal/vocabulary/README）と区別する。**
// seedは一度作れば以後ユーザーのものだが、同梱Queryは Core が後から増やす資産であり、
// 既にある .os には writeIfAbsent 方式のせいで永久に届かない。
// この不足は「Queryが足りない」ではなく「Coreの更新が届いていない」なので、
// missingBundledQueries で名指しできるようにしてある（check が警告し、migrate が報告する）。
//
// **不変条件: Coreが自分で書き込む型は、必ずどれかの同梱Queryが返せること。**
// Coreが書くのは decision（decision new）/ outcome（decision outcome）/
// evidence（task consolidate）/ unknown（gap --assert）の4種で、
// どれか1つでも引けないと「その器官を使った瞬間に wm_reachability が落ちる」ことになる。
// 学習を前へ進める操作が検査を壊す向きになってはいけない。
const BUNDLED_QUERIES = {
  get_past_decisions: QUERY_PAST_DECISIONS,
  get_decision_outcomes: QUERY_DECISION_OUTCOMES,
  get_lesson_evidence: QUERY_LESSON_EVIDENCE,
  get_open_unknowns: QUERY_OPEN_UNKNOWNS,
};

// 既存の .os に届いていない同梱Queryを返す。中身の差分は見ない —
// ユーザーが調整したQueryを「ズレている」と言い出すと、調整する自由を奪うことになる。
function missingBundledQueries(osDir) {
  return Object.keys(BUNDLED_QUERIES)
    .filter((name) => !fs.existsSync(path.join(osDir, 'queries', `${name}.yaml`)))
    .sort();
}

const OS_README = `# .os/ — ユーザー固有Intelligence OS

このディレクトリはautopoiesys OSS Coreが生成・操作するユーザー固有OSである。
形式契約はOSS側のSCHEMA.mdを参照。全状態変化はgit diffで監査できる。
OSS本体とは分離して、このディレクトリ自体を独立にバージョン管理することを推奨する。
`;

// 対象ワークスペースにClaude Code用のスキル（.claude/skills/）を配置する。
// 正本はOSS側 skills/ で、ここに置かれるのはその生成コピー。
// 以前は「正本をReadせよ」と書いた参照スタブだったが、①毎回1回余分なReadを強制し
// ②スタブと正本のズレを検出できなかったため、内容ごと生成して差分検査可能にした。
const GENERATED_MARK = 'autopoiesys:generated';
// 参照スタブ時代の生成物。ユーザーが書いたファイルと区別して置き換える
const LEGACY_STUB_MARK = 'このSkillの正本は';

function generatedSkillBody(name, canonicalText) {
  const marker = `<!-- ${GENERATED_MARK} source=skills/${name}/SKILL.md — skills sync の生成物。編集は正本側に行う -->`;
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(canonicalText);
  if (!m) return `${marker}\n\n${canonicalText}`;
  // マーカー行を除けば正本とバイト一致する（差分検査を素直にするため余分な空行を入れない）
  return `${m[0]}${marker}\n${canonicalText.slice(m[0].length)}`;
}

// 生成物として上書きしてよいか。marker付き（自分の生成物）か、参照スタブ時代の
// 生成物ならtrue。ユーザーが書いた内容は保護する
function isManagedSkillFile(text) {
  return text.includes(GENERATED_MARK) || text.includes(LEGACY_STUB_MARK);
}

// check=true では書き込まず、正本とズレているものを stale として返す
function syncSkills(targetDir, { check = false } = {}) {
  const skillsRoot = path.join(OSS_ROOT, 'skills');
  const created = [];
  const updated = [];
  const unchanged = [];
  const skipped = [];
  const stale = [];
  if (!fs.existsSync(skillsRoot)) return { created, updated, unchanged, skipped, stale };
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const canonical = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(canonical)) continue;
    const want = generatedSkillBody(entry.name, readTextFile(canonical));
    const dest = path.join(targetDir, '.claude', 'skills', entry.name, 'SKILL.md');
    if (!fs.existsSync(dest)) {
      if (check) stale.push(entry.name);
      else atomicWriteFile(dest, want);
      created.push(entry.name);
      continue;
    }
    const current = readTextFile(dest);
    if (current === want) {
      unchanged.push(entry.name);
      continue;
    }
    if (!isManagedSkillFile(current)) {
      skipped.push(entry.name); // ユーザーが書き換えた内容は巻き戻さない
      continue;
    }
    if (check) stale.push(entry.name);
    else atomicWriteFile(dest, want);
    updated.push(entry.name);
  }
  return { created, updated, unchanged, skipped, stale };
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
  for (const [name, content] of Object.entries(BUNDLED_QUERIES)) {
    writeIfAbsent(path.join('queries', `${name}.yaml`), content);
  }
  writeIfAbsent('README.md', OS_README);
  const stubs = syncSkills(targetDir);
  return { osDir, created: dirs, skill_stubs: stubs };
}

module.exports = { doctor, initOs, syncSkills, missingBundledQueries, BUNDLED_QUERIES };
