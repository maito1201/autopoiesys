'use strict';
// 手順の事前固定（pre-registration）。検証手順を書いたファイルのハッシュをタスク台帳に
// 追記し、「結果を見た後に手順を変えた」かどうかを決定的に検査できるようにする。
//
// 重要: PLANが変更されていること自体は違反ではない（計画の更新は正当でありうる）。
// ここが提供するのは「変更された事実」と「その前後関係が判定できるか否か」だけであり、
// 良し悪しは判定しない。記録から決まらないことは「判定不能」と書く（捏造した判定を返さない）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nowIso, readTextFile } = require('./util');
const { getTask, updateTask } = require('./evaluate');

// PLANのパス解決基準。artifactの解決と同じ順序で探す
// （work_dir → repo_dirs → .os の親）。
function planBases(osDir, task) {
  const bases = [];
  if (task && task.work_dir) bases.push(task.work_dir);
  for (const d of Object.values((task && task.repo_dirs) || {})) bases.push(d);
  bases.push(path.dirname(osDir));
  return bases;
}

function resolvePlanPath(osDir, task, p) {
  const bases = planBases(osDir, task);
  if (path.isAbsolute(p)) return path.normalize(p);
  for (const b of bases) {
    const full = path.resolve(b, p);
    if (fs.existsSync(full)) return full;
  }
  return path.resolve(bases[0], p);
}

// 台帳には相対パス（区切りは/固定）で残す。絶対パスは別マシン・別worktreeで
// 意味を失い、照合そのものが不能になる。基準の外にあるファイルだけ絶対パスで残す。
function toLedgerPath(osDir, task, abs) {
  let best = null;
  for (const b of planBases(osDir, task)) {
    const rel = path.relative(path.resolve(b), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (best === null || rel.length < best.length) best = rel;
  }
  if (best === null) return abs.split(path.sep).join('/');
  return best.split(path.sep).join('/');
}

// BOM除去・CRLF→LF正規化したテキストのSHA-256。
// バイト列そのままだと、PowerShell等が保存し直しただけ（BOM付与・改行変換）で
// 「手順が変わった」という偽の警告が出る。手順の変更だけを見たいのでテキストで測る。
function hashPlanFile(file) {
  const text = readTextFile(file).replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// PLANを事前固定として登録する。追記専用（同じパスの再登録も履歴として残し、上書きしない）。
function registerPlan(osDir, taskId, planPath) {
  if (!planPath) throw new Error('PLANのパスが必要');
  const task = getTask(osDir, taskId);
  const abs = resolvePlanPath(osDir, task, String(planPath));
  if (!fs.existsSync(abs)) {
    throw new Error(`PLANファイルが存在しない: ${planPath}（解決先: ${abs}）`);
  }
  if (!fs.statSync(abs).isFile()) {
    throw new Error(`PLANはファイルで指定する（ディレクトリが指定された）: ${abs}`);
  }
  const rel = toLedgerPath(osDir, task, abs);
  const hash = hashPlanFile(abs);
  const entry = { ts: nowIso(), path: rel, hash };
  const plans = [...(task.plans || []), entry];
  updateTask(osDir, taskId, { plans });
  const samePath = plans.filter((p) => p.path === rel);
  return {
    task: taskId,
    path: rel,
    hash,
    ts: entry.ts,
    index: plans.length, // タスク全体で何件目の登録か
    path_index: samePath.length, // このパスとして何件目の登録か
  };
}

// 登録済みPLANと現在のファイル内容を照合する。
// artifactの登録時刻が分かる場合のみ、artifact登録後の「再登録」を前後関係として示す。
// 内容変更の時刻はOSに記録が無いため、artifactの前後は判定不能と明示する。
function verifyPlans(osDir, taskId) {
  const task = getTask(osDir, taskId);
  const registrations = task.plans || [];
  const artifacts = task.artifacts || [];
  const artifactTs = artifacts.map((a) => a && a.ts).filter(Boolean).sort();
  const latestArtifactTs = artifactTs.length ? artifactTs[artifactTs.length - 1] : null;
  const warnings = [];
  if (!registrations.length) {
    return {
      task: taskId,
      ok: true,
      registered: 0,
      plans: [],
      warnings: [
        '事前固定された手順は無い（PLAN未登録）。手順が結果を見た後に変えられていないかはOSでは検査できない',
      ],
    };
  }
  if (artifacts.length && !latestArtifactTs) {
    warnings.push(
      'artifacts[] に登録時刻が記録されていないため、artifact登録後の変更かどうかは判定不能' +
      '（ファイルのmtimeは根拠にしない）'
    );
  }
  // 同じパスの登録はすべて履歴として残る。照合の基準は最新の登録。
  const byPath = new Map();
  for (const r of registrations) {
    const list = byPath.get(r.path) || [];
    list.push(r);
    byPath.set(r.path, list);
  }
  const plans = [];
  let ok = true;
  for (const [rel, list] of byPath) {
    const last = list[list.length - 1];
    const abs = resolvePlanPath(osDir, task, rel);
    const w = [];
    let currentHash = null;
    let changed = null; // null = 照合不能（存在しないファイルを「変更なし」とは言わない）
    if (!fs.existsSync(abs)) {
      ok = false;
      w.push(`登録されたPLANファイルが見つからない（解決先: ${abs}）。変更の有無は判定不能`);
    } else {
      currentHash = hashPlanFile(abs);
      changed = currentHash !== last.hash;
      if (changed) {
        ok = false;
        w.push(
          `最新登録（${last.ts}）のハッシュと現在の内容が一致しない: PLANは登録後に変更されている。` +
          '計画の更新それ自体は違反ではないが、変更が結果を見る前か後かはこの記録からは決まらない'
        );
        w.push(
          latestArtifactTs
            ? `内容が変更された時刻はOSに記録されていないため、artifact登録（${latestArtifactTs}）` +
              'より後の変更かどうかは判定不能。前後を判定可能にするには、変更のたびに再登録すること'
            : 'artifactの登録時刻が台帳に無いため、artifact登録後の変更かどうかは判定不能'
        );
      }
    }
    // 再登録は時刻が記録されているので、artifactとの前後を決定的に言える唯一の材料。
    // 秒解像度のため、同一秒の登録は保守的に「後」とは扱わない。
    if (latestArtifactTs) {
      const after = list.filter((r) => r.ts > latestArtifactTs);
      if (after.length) {
        w.push(
          `artifact登録（${latestArtifactTs}）より後にこのPLANが再登録されている` +
          `（${after.map((r) => r.ts).join(', ')}）。手順の更新は正当でありうるが、` +
          '成果を見た後の変更でないことを説明できる状態にせよ'
        );
      }
    }
    plans.push({
      path: rel,
      registered_hash: last.hash,
      registered_ts: last.ts,
      current_hash: currentHash,
      changed,
      registrations: list.length,
      warnings: w,
    });
  }
  return { task: taskId, ok, registered: registrations.length, plans, warnings };
}

// briefingに差し込むMarkdown断片（配列of文字列）。判定材料として提示するだけで、
// 変更を違反として断じない。
function plansSection(osDir, taskId) {
  const parts = ['## 事前固定された検証手順（PLANのハッシュ照合。機械記録）'];
  let res;
  try {
    res = verifyPlans(osDir, taskId);
  } catch (e) {
    parts.push('', `(照合エラー: ${e.message})`, '');
    return parts;
  }
  parts.push('');
  if (!res.plans.length) {
    parts.push('**このタスクに事前固定された手順は無い**（PLAN未登録）。');
    parts.push('検証手順が結果を見た後に変えられていないかを、OSは検査できない。');
    parts.push('手順の妥当性に依存する判定は、報告本文の自己申告だけを根拠にPASSとしないこと。');
    parts.push('');
    return parts;
  }
  for (const p of res.plans) {
    const state = p.changed === null
      ? '照合不能'
      : (p.changed ? '登録後に変更あり' : '登録時から変更なし');
    parts.push(
      `- ${p.path}: ${state}（登録${p.registrations}件、最新登録 ${p.registered_ts}、` +
      `hash ${String(p.registered_hash).slice(0, 12)}…）`
    );
    for (const w of p.warnings) parts.push(`  - ${w}`);
  }
  for (const w of res.warnings) parts.push(`- ${w}`);
  parts.push('');
  parts.push('注: PLANの変更それ自体は違反ではない（計画の更新は正当でありうる）。');
  parts.push('ここにあるのは「変更された事実」であり、その妥当性は報告の説明と併せて判断すること。');
  parts.push('');
  return parts;
}

module.exports = {
  registerPlan,
  verifyPlans,
  plansSection,
  hashPlanFile,
  resolvePlanPath,
};
