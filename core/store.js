'use strict';
// World Modelストア: events.jsonl（正本・追記専用）と snapshot.json（決定的に再生成されるキャッシュ）
const fs = require('node:fs');
const path = require('node:path');
const { readJsonl, appendJsonl, atomicWriteFile, stableStringify, sha1, nowIso, nextId, readTextFile } = require('./util');
const { parseYaml } = require('./yaml');

const STATEMENT_TYPES = [
  'entity', 'relationship', 'observation', 'claim', 'evidence', 'hypothesis',
  'unknown', 'decision', 'constraint', 'goal', 'outcome', 'failure',
];
const STATUSES = ['fact', 'hypothesis', 'unknown', 'retracted'];
const LINK_ROLES = ['supports', 'counters', 'about', 'derived_from', 'relates_to', 'caused_by', 'prevents'];
const PROVENANCE_METHODS = ['deterministic', 'llm', 'human'];

function eventsFile(osDir) {
  return path.join(osDir, 'world_model', 'events.jsonl');
}

function snapshotFile(osDir) {
  return path.join(osDir, 'world_model', 'snapshot.json');
}

function loadEvents(osDir) {
  return readJsonl(eventsFile(osDir));
}

function loadVocabulary(osDir) {
  const file = path.join(osDir, 'world_model', 'vocabulary.yaml');
  if (!fs.existsSync(file)) return { predicates: [], tags: [] };
  const v = parseYaml(readTextFile(file)) || {};
  return { predicates: v.predicates || [], tags: v.tags || [] };
}

// 1件のStatementを検証する。knownIds には既存+同一バッチのIDを渡す。
function validateStatement(st, { knownIds, vocab, strict }) {
  const errors = [];
  const warnings = [];
  const label = st && st.id ? st.id : '(no id)';
  if (!st || typeof st !== 'object') return { errors: ['Statementがオブジェクトでない'], warnings };
  for (const f of ['id', 'ts', 'type', 'body', 'status', 'provenance']) {
    if (st[f] === undefined || st[f] === null || st[f] === '') errors.push(`${label}: 必須フィールド欠落: ${f}`);
  }
  if (st.id && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(st.id)) errors.push(`${label}: 不正なid形式`);
  if (st.type && !STATEMENT_TYPES.includes(st.type)) errors.push(`${label}: 不正なtype: ${st.type}`);
  if (st.status && !STATUSES.includes(st.status)) errors.push(`${label}: 不正なstatus: ${st.status}`);
  if (st.confidence !== undefined && (typeof st.confidence !== 'number' || st.confidence < 0 || st.confidence > 1)) {
    errors.push(`${label}: confidenceは0..1の数値`);
  }
  if (st.provenance) {
    if (!st.provenance.source) errors.push(`${label}: provenance.source欠落`);
    if (!PROVENANCE_METHODS.includes(st.provenance.method)) {
      errors.push(`${label}: provenance.methodは ${PROVENANCE_METHODS.join('|')}`);
    }
  }
  if (st.links !== undefined) {
    if (!Array.isArray(st.links)) {
      errors.push(`${label}: linksは配列`);
    } else {
      for (const l of st.links) {
        if (!l || !l.role || !l.to) {
          errors.push(`${label}: linkは{role, to}が必須`);
          continue;
        }
        if (!LINK_ROLES.includes(l.role)) errors.push(`${label}: 不正なlink role: ${l.role}`);
        if (knownIds && !knownIds.has(l.to)) errors.push(`${label}: link先が存在しない: ${l.to}`);
      }
    }
  }
  if (st.supersedes && knownIds && !knownIds.has(st.supersedes)) {
    errors.push(`${label}: supersedes先が存在しない: ${st.supersedes}`);
  }
  if (st.tags !== undefined && (!Array.isArray(st.tags) || st.tags.some((t) => typeof t !== 'string'))) {
    errors.push(`${label}: tagsは文字列の配列`);
  }
  if (st.predicate && vocab && !vocab.predicates.includes(st.predicate)) {
    const msg = `${label}: 未登録のpredicate: ${st.predicate}（vocabulary.yamlに登録推奨）`;
    if (strict) errors.push(msg);
    else warnings.push(msg);
  }
  if (Array.isArray(st.tags) && vocab) {
    for (const t of st.tags) {
      if (!vocab.tags.includes(t)) {
        const msg = `${label}: 未登録のtag: ${t}`;
        if (strict) errors.push(msg);
        else warnings.push(msg);
      }
    }
  }
  return { errors, warnings };
}

// Statement群を検証して追記する。既存idはスキップ（冪等）。1件でもエラーがあれば何も書かない。
function assertStatements(osDir, statements, { strict = false } = {}) {
  const existing = loadEvents(osDir);
  const knownIds = new Set(existing.map((e) => e.id));
  const vocab = loadVocabulary(osDir);
  const toAdd = [];
  const skipped = [];
  const allErrors = [];
  const allWarnings = [];
  const batchIds = new Set(knownIds);
  const accepted = [];
  for (const st of statements) {
    if (st && st.id === undefined) {
      st.id = nextId('S', batchIds, 4);
    }
    if (st && !st.ts) st.ts = nowIso();
    if (st && batchIds.has(st.id)) {
      if (knownIds.has(st.id)) {
        skipped.push(st.id); // 既存idの再投入は冪等スキップ
      } else {
        allErrors.push(`${st.id}: 同一バッチ内でidが重複`);
      }
      continue;
    }
    batchIds.add(st.id);
    accepted.push(st);
  }
  for (const st of accepted) {
    const { errors, warnings } = validateStatement(st, { knownIds: batchIds, vocab, strict });
    allErrors.push(...errors);
    allWarnings.push(...warnings);
    toAdd.push(st);
  }
  if (allErrors.length) {
    const e = new Error(`Statement検証エラー:\n  ${allErrors.join('\n  ')}`);
    e.errors = allErrors;
    throw e;
  }
  for (const st of toAdd) appendJsonl(eventsFile(osDir), st);
  return { added: toAdd.map((s) => s.id), skipped, warnings: allWarnings };
}

// タスク実行中の学習をその場で1件還流する（run-taskの statement add / supersede が呼ぶ）。
// 学習はタスク終了時・失敗時に限らない: コードで裏取りした事実、仕様と実装の矛盾、
// ユーザーから受けた運用ルールは、発見した時点でWorld Modelに追記する。
// supersedes指定時は現在状態の旧Statementから type/status/tags/predicate を未指定分だけ継承する。
function recordStatement(osDir, fields) {
  if (!fields.body) throw new Error('bodyが必要');
  let base = {};
  if (fields.supersedes) {
    const snap = getSnapshot(osDir);
    const old = snap.statements[fields.supersedes];
    if (!old) throw new Error(`supersedes先が現在状態に存在しない（既に置換済みか、id誤り）: ${fields.supersedes}`);
    base = { type: old.type, status: old.status, tags: old.tags, predicate: old.predicate };
  }
  const type = fields.type || base.type;
  if (!type) throw new Error('--typeが必要（supersede時は旧Statementから継承される）');
  const status = fields.status || base.status || 'fact';
  if (status === 'hypothesis' && fields.confidence === undefined) {
    throw new Error('status=hypothesis には --confidence（0..1）が必要');
  }
  const provenance = { source: fields.source, method: fields.method || 'llm' };
  if (fields.task) provenance.task = fields.task;
  const st = {
    type,
    body: fields.body,
    status,
    tags: fields.tags !== undefined ? fields.tags : base.tags,
    predicate: fields.predicate || base.predicate,
    confidence: fields.confidence,
    links: fields.links,
    supersedes: fields.supersedes,
    provenance,
  };
  for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
  return assertStatements(osDir, [st]);
}

// supersedes/retractedを畳み込んだ現在状態と索引を決定的に構築する
function buildSnapshot(events) {
  const byId = {};
  const superseded = new Set();
  for (const st of events) {
    byId[st.id] = st;
    if (st.supersedes) superseded.add(st.supersedes);
  }
  const current = {};
  const byType = {};
  const byTag = {};
  const linksIn = {};
  for (const st of events) {
    if (superseded.has(st.id)) continue;
    if (st.status === 'retracted') continue;
    current[st.id] = st;
  }
  for (const id of Object.keys(current).sort()) {
    const st = current[id];
    (byType[st.type] = byType[st.type] || []).push(id);
    for (const t of st.tags || []) (byTag[t] = byTag[t] || []).push(id);
    for (const l of st.links || []) {
      (linksIn[l.to] = linksIn[l.to] || []).push({ from: id, role: l.role });
    }
  }
  return {
    meta: { event_count: events.length },
    statements: current,
    indexes: { by_type: byType, by_tag: byTag, links_in: linksIn },
  };
}

function rebuildSnapshot(osDir) {
  const events = loadEvents(osDir);
  const snap = buildSnapshot(events);
  const raw = fs.existsSync(eventsFile(osDir)) ? fs.readFileSync(eventsFile(osDir), 'utf8') : '';
  snap.meta.source_checksum = sha1(raw);
  atomicWriteFile(snapshotFile(osDir), stableStringify(snap, 2) + '\n');
  return snap;
}

// snapshotが正本と一致しているか確認し、古ければ再生成して返す
function getSnapshot(osDir) {
  const file = snapshotFile(osDir);
  const raw = fs.existsSync(eventsFile(osDir)) ? fs.readFileSync(eventsFile(osDir), 'utf8') : '';
  const checksum = sha1(raw);
  if (fs.existsSync(file)) {
    try {
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (snap.meta && snap.meta.source_checksum === checksum) return snap;
    } catch {
      // 壊れたsnapshotは再生成する
    }
  }
  return rebuildSnapshot(osDir);
}

// リンク整合・語彙のlint（`autopoiesys check` 用）
function lintWorldModel(osDir, { strict = false } = {}) {
  const events = loadEvents(osDir);
  const ids = new Set(events.map((e) => e.id));
  const vocab = loadVocabulary(osDir);
  const errors = [];
  const warnings = [];
  const seen = new Set();
  for (const st of events) {
    if (seen.has(st.id)) {
      // 同一idの再出現は現状スキーマでは想定しない（statusの更新はsupersedesで表現）
      warnings.push(`${st.id}: idが重複している（後の行が優先されない点に注意）`);
    }
    seen.add(st.id);
    const { errors: e, warnings: w } = validateStatement(st, { knownIds: ids, vocab, strict });
    errors.push(...e);
    warnings.push(...w);
  }
  return { errors, warnings, count: events.length };
}

module.exports = {
  STATEMENT_TYPES,
  STATUSES,
  LINK_ROLES,
  eventsFile,
  loadEvents,
  loadVocabulary,
  validateStatement,
  assertStatements,
  recordStatement,
  buildSnapshot,
  rebuildSnapshot,
  getSnapshot,
  lintWorldModel,
};
