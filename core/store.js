'use strict';
// World Modelストア: events.jsonl（正本・追記専用）と snapshot.json（決定的に再生成されるキャッシュ）
const fs = require('node:fs');
const path = require('node:path');
const { readJsonl, appendJsonl, atomicWriteFile, stableStringify, sha1, nowIso, nextId, readTextFile } = require('./util');
const { parseYaml } = require('./yaml');

const STATEMENT_TYPES = [
  'entity', 'relationship', 'observation', 'claim', 'evidence', 'hypothesis',
  'unknown', 'decision', 'constraint', 'goal', 'outcome', 'failure',
  'capability', // Goal分解（CONCEPTv2 §5）の受け皿。Gap分析の分類単位
  // 蒸留された経験。生ログではなく「次に同種の仕事をするとき使える1行」。
  // 適用条件（when）とタスク類型（task_class）を持ち、再来時に黙っていても届く
  'lesson',
];
const STATUSES = ['fact', 'hypothesis', 'unknown', 'retracted'];
const LINK_ROLES = ['supports', 'counters', 'about', 'derived_from', 'relates_to', 'caused_by', 'prevents'];
const PROVENANCE_METHODS = ['deterministic', 'llm', 'human'];

// snapshotの論理スキーマ版。索引の形が変わったらインクリメントする —
// これが無いとコア更新後も旧snapshotがchecksum一致で有効判定され、新索引が空のまま沈黙する。
const SNAPSHOT_SCHEMA_VERSION = 2;

// World Model外の正本台帳への型付き参照（relationshipの端点に使える）。
// 台帳の実体をノードとして複製せず、参照の実在だけをコアが検証する。
const ASSET_REF_RE = /^(evaluator|query|golden_task|task|failure|skill):([A-Za-z0-9][A-Za-z0-9_-]*)$/;

function isAssetRef(id) {
  return ASSET_REF_RE.test(String(id));
}

// osDirに対するasset refの実在検証器を作る（台帳の読込は1回だけ）
function makeAssetChecker(osDir) {
  let taskIds = null;
  let failureIds = null;
  return (ref) => {
    const m = ASSET_REF_RE.exec(String(ref));
    if (!m) return false;
    const [, kind, name] = m;
    if (kind === 'evaluator') return fs.existsSync(path.join(osDir, 'evaluators', `${name}.yaml`));
    if (kind === 'query') return fs.existsSync(path.join(osDir, 'queries', `${name}.yaml`));
    if (kind === 'golden_task') return fs.existsSync(path.join(osDir, 'golden_tasks', `${name}.yaml`));
    if (kind === 'task') {
      if (!taskIds) taskIds = new Set(readJsonl(path.join(osDir, 'tasks', 'tasks.jsonl')).map((t) => t.id));
      return taskIds.has(name);
    }
    if (kind === 'failure') {
      if (!failureIds) failureIds = new Set(readJsonl(path.join(osDir, 'failures', 'ledger.jsonl')).map((f) => f.id));
      return failureIds.has(name);
    }
    if (kind === 'skill') {
      const ws = path.dirname(osDir);
      return fs.existsSync(path.join(ws, '.claude', 'skills', name, 'SKILL.md'))
        || fs.existsSync(path.join(ws, 'skills', name, 'SKILL.md'));
    }
    return false;
  };
}

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
  if (!fs.existsSync(file)) return { predicates: [], tags: [], scopes: [] };
  const v = parseYaml(readTextFile(file)) || {};
  return { predicates: v.predicates || [], tags: v.tags || [], scopes: v.scopes || [] };
}

// 既存イベントで使用実績のあるtag/predicate（登録簿とは別の「既成事実」の語彙）。
// 登録簿(vocabulary.yaml)との照合だけだと、一度warning付きで通った語彙に対して
// 以後の還流のたびに同じ警告を繰り返してノイズになるため、警告は真の初出に限る。
function usedVocabulary(events) {
  const tags = new Set();
  const predicates = new Set();
  const scopes = new Set();
  for (const e of events) {
    for (const t of e.tags || []) tags.add(t);
    for (const sc of e.scope || []) scopes.add(sc);
    if (e.predicate) predicates.add(e.predicate);
  }
  return { tags, predicates, scopes };
}

// 1件のStatementを検証する。knownIds には既存+同一バッチのIDを渡す。
// used（使用実績のある語彙）を渡すと、非strict時は初出の語彙のみ警告する。
function validateStatement(st, { knownIds, vocab, used, strict, assetCheck }) {
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
  // scope: このStatementが適用される対象（リポジトリ等）の配列。省略は「対象に依らない知識」を意味し、
  // scope絞りのQueryには乗らない（tagsは話題、scopeは宛先という分離）。
  if (st.scope !== undefined && (!Array.isArray(st.scope) || st.scope.some((v) => typeof v !== 'string'))) {
    errors.push(`${label}: scopeは文字列の配列`);
  }
  if (Array.isArray(st.scope) && vocab) {
    for (const sc of st.scope) {
      if (vocab.scopes.includes(sc)) continue;
      if (strict) {
        errors.push(`${label}: 未登録のscope: ${sc}（strict_vocabulary有効。vocabulary.yamlのscopesに登録が必要）`);
      } else if (!used || !used.scopes.has(sc)) {
        warnings.push(`${label}: 初出のscope: ${sc}（typoでなければそのまま使える。安定したら world_model/vocabulary.yaml のscopesに登録）`);
      }
    }
  }
  // unknown = 第一級のUnknown（CONCEPTv2 §13）。「分からない」を body の散文で終わらせず、
  // 何の判断を塞いでいるか（blocks）と、どれだけ効くか（importance）を構造で持たせる。
  // blocks に書かれたIDの実在は検証しない（判断・基準・台帳など別空間のIDが入りうる）。
  if (st.blocks !== undefined) {
    if (st.type !== 'unknown') {
      errors.push(`${label}: blocksは type: unknown でのみ使える`);
    } else if (!Array.isArray(st.blocks) || st.blocks.some((b) => typeof b !== 'string' || b === '')) {
      errors.push(`${label}: blocksは文字列の配列（このUnknownが塞いでいる判断・基準のID列）`);
    }
  }
  if (st.importance !== undefined) {
    if (st.type !== 'unknown') {
      errors.push(`${label}: importanceは type: unknown でのみ使える`);
    } else if (typeof st.importance !== 'number' || Number.isNaN(st.importance)
        || st.importance < 0 || st.importance > 1) {
      errors.push(`${label}: importanceは0..1の数値`);
    }
  }
  // lesson専用フィールド。when = 適用条件（いつこの教訓が効くか）、
  // task_class = タスク類型のfingerprint（同種のタスクの再来時に届けるための鍵）。
  if (st.when !== undefined) {
    if (st.type !== 'lesson') {
      errors.push(`${label}: whenは type: lesson でのみ使える`);
    } else if (typeof st.when !== 'string' || !st.when.trim()) {
      errors.push(`${label}: whenは空でない文字列（この教訓がいつ適用されるかの1行）`);
    }
  }
  if (st.task_class !== undefined) {
    if (st.type !== 'lesson') {
      errors.push(`${label}: task_classは type: lesson でのみ使える`);
    } else if (typeof st.task_class !== 'string' || !st.task_class.trim()) {
      errors.push(`${label}: task_classは空でない文字列（タスク類型のfingerprint）`);
    }
  }
  // situation = 判断の場の抽象。これが無いと同じ判断の再来を検出できないので、
  // decision以外に付いているのは取り違えとして落とす。
  if (st.situation !== undefined) {
    if (st.type !== 'decision') {
      errors.push(`${label}: situationは type: decision でのみ使える`);
    } else if (typeof st.situation !== 'string' || !st.situation.trim()) {
      errors.push(`${label}: situationは空でない文字列（何を選ぶ場面かの1行の抽象）`);
    }
  }
  for (const f of ['conditions', 'exceptions']) {
    if (st[f] !== undefined && (!Array.isArray(st[f]) || st[f].some((c) => typeof c !== 'string'))) {
      errors.push(`${label}: ${f}は文字列の配列`);
    }
  }
  // relationship = 第一級Relation（CONCEPTv2 §4）。端点の実在を強制する —
  // LLMは辺を提案できるが、捏造された束縛は書き込めない。
  if (st.type === 'relationship') {
    for (const f of ['subject', 'predicate', 'object']) {
      if (!st[f]) errors.push(`${label}: relationshipは${f}が必須`);
    }
    for (const f of ['subject', 'object']) {
      const v = st[f];
      if (!v) continue;
      if (knownIds && knownIds.has(v)) continue;
      if (isAssetRef(v)) {
        if (assetCheck && !assetCheck(v)) errors.push(`${label}: ${f}の参照先が実在しない: ${v}`);
        continue;
      }
      if (knownIds) errors.push(`${label}: ${f}が存在しない: ${v}（StatementIDまたは evaluator:|query:|golden_task:|task:|failure:|skill: の型付き参照）`);
    }
  }
  if (st.predicate && vocab && !vocab.predicates.includes(st.predicate)) {
    if (strict) {
      errors.push(`${label}: 未登録のpredicate: ${st.predicate}（strict_vocabulary有効。vocabulary.yamlに登録が必要）`);
    } else if (!used || !used.predicates.has(st.predicate)) {
      warnings.push(`${label}: 初出のpredicate: ${st.predicate}（typoでなければそのまま使える。安定したら world_model/vocabulary.yaml に登録）`);
    }
  }
  if (Array.isArray(st.tags) && vocab) {
    for (const t of st.tags) {
      if (vocab.tags.includes(t)) continue;
      if (strict) {
        errors.push(`${label}: 未登録のtag: ${t}（strict_vocabulary有効。vocabulary.yamlに登録が必要）`);
      } else if (!used || !used.tags.has(t)) {
        warnings.push(`${label}: 初出のtag: ${t}（typoでなければそのまま使える。安定したら world_model/vocabulary.yaml に登録）`);
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
  const used = usedVocabulary(existing);
  const assetCheck = makeAssetChecker(osDir);
  for (const st of accepted) {
    const { errors, warnings } = validateStatement(st, { knownIds: batchIds, vocab, used, strict, assetCheck });
    allErrors.push(...errors);
    allWarnings.push(...warnings);
    // 同一バッチ内の再利用は警告しない（初出の1回だけ）
    for (const t of st.tags || []) used.tags.add(t);
    for (const sc of st.scope || []) used.scopes.add(sc);
    if (st.predicate) used.predicates.add(st.predicate);
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
    base = { type: old.type, status: old.status, tags: old.tags, scope: old.scope, predicate: old.predicate };
  }
  const type = fields.type || base.type;
  if (!type) throw new Error('--typeが必要（supersede時は旧Statementから継承される）');
  // type: unknown を status: fact で記録するのは語義矛盾（「分からないことが事実」）。
  // 既定を型から決め、Unknownが事実として索引に載るのを防ぐ。
  const status = fields.status || base.status || (type === 'unknown' ? 'unknown' : 'fact');
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
    scope: fields.scope !== undefined ? fields.scope : base.scope,
    subject: fields.subject,
    predicate: fields.predicate || base.predicate,
    object: fields.object,
    conditions: fields.conditions,
    exceptions: fields.exceptions,
    confidence: fields.confidence,
    // Unknown専用（CONCEPTv2 §13）。type: unknown 以外に付くと検証エラーになる
    blocks: fields.blocks,
    importance: fields.importance,
    // lesson専用。type: lesson 以外に付くと検証エラーになる
    when: fields.when,
    task_class: fields.task_class,
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
  const byScope = {};
  const linksIn = {};
  for (const st of events) {
    if (superseded.has(st.id)) continue;
    if (st.status === 'retracted') continue;
    current[st.id] = st;
  }
  // 統合辺ビュー: relationship（第一級・属性つき）と links[]（軽量配管）を
  // 単一の辺集合に統合し、traverse（多段走査）の基盤にする。
  const edgesOut = {};
  const edgesIn = {};
  const addEdge = (edge) => {
    (edgesOut[edge.from] = edgesOut[edge.from] || []).push(edge);
    (edgesIn[edge.to] = edgesIn[edge.to] || []).push(edge);
  };
  for (const id of Object.keys(current).sort()) {
    const st = current[id];
    (byType[st.type] = byType[st.type] || []).push(id);
    for (const t of st.tags || []) (byTag[t] = byTag[t] || []).push(id);
    for (const sc of st.scope || []) (byScope[sc] = byScope[sc] || []).push(id);
    for (const l of st.links || []) {
      (linksIn[l.to] = linksIn[l.to] || []).push({ from: id, role: l.role });
      addEdge({ from: id, to: l.to, kind: l.role, via: id });
    }
    if (st.type === 'relationship' && st.subject && st.object) {
      const edge = { from: st.subject, to: st.object, kind: st.predicate, via: id, status: st.status };
      if (st.confidence !== undefined) edge.confidence = st.confidence;
      addEdge(edge);
    }
  }
  return {
    meta: { event_count: events.length, schema_version: SNAPSHOT_SCHEMA_VERSION },
    statements: current,
    indexes: { by_type: byType, by_tag: byTag, by_scope: byScope, links_in: linksIn, edges_out: edgesOut, edges_in: edgesIn },
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
      // checksum一致でもスキーマ版が古ければ再生成する（コア更新後の索引欠落による沈黙バグ防止）
      if (snap.meta && snap.meta.source_checksum === checksum
          && snap.meta.schema_version === SNAPSHOT_SCHEMA_VERSION) return snap;
    } catch {
      // 壊れたsnapshotは再生成する
    }
  }
  return rebuildSnapshot(osDir);
}

// scopeの後埋め（migration）。多リポジトリ横断のためにscopeを導入した時点で、既存Statementは
// 宛先を持たない。tagsに現れているscope名（vocabulary.yamlのscopesが正本）を宛先として写す。
// 写せないものはscopeなし＝「対象リポジトリに依らない知識」として残す（過剰包含側に倒す:
// scopeを誤って付けるとscope絞りのQueryから知識が消えるが、付けないだけなら話題tagで引ける）。
// ingest-repo観測はtagsに宛先を持たないため、fallbackScopeを明示で指定した時だけ写す。
function backfillScope(osDir, { scopes, fallbackScope, fallbackSource = 'ingest-repo', apply = false } = {}) {
  const known = new Set(scopes || []);
  if (!known.size) throw new Error('backfillScope: scopes（宛先名の登録簿）が空。vocabulary.yamlのscopesを先に定義せよ');
  const events = loadEvents(osDir);
  const byScope = {};
  const changed = [];
  let alreadyScoped = 0;
  let leftCommon = 0;
  const next = events.map((st) => {
    if (Array.isArray(st.scope) && st.scope.length) {
      alreadyScoped++;
      return st;
    }
    let derived = (st.tags || []).filter((t) => known.has(t));
    if (!derived.length && fallbackScope && st.provenance && st.provenance.source === fallbackSource) {
      derived = [fallbackScope];
    }
    if (!derived.length) {
      leftCommon++;
      return st;
    }
    for (const sc of derived) byScope[sc] = (byScope[sc] || 0) + 1;
    changed.push({ id: st.id, scope: derived });
    return { ...st, scope: derived };
  });
  const report = {
    events: events.length,
    scoped: changed.length,
    already_scoped: alreadyScoped,
    left_without_scope: leftCommon,
    by_scope: byScope,
    applied: false,
  };
  if (!apply) return report;
  const file = eventsFile(osDir);
  // 破壊的な書き換えなので、適用前の原本を隣に残す（git履歴と二重の保険）
  if (fs.existsSync(file)) atomicWriteFile(`${file}.pre-scope-backfill`, fs.readFileSync(file, 'utf8'));
  atomicWriteFile(file, next.map((st) => stableStringify(st)).join('\n') + (next.length ? '\n' : ''));
  rebuildSnapshot(osDir);
  report.applied = true;
  report.backup = `${file}.pre-scope-backfill`;
  return report;
}

// リンク整合・語彙のlint（`autopoiesys check` 用）。
// 既存Statementの語彙は使用実績＝既知として扱い、per-statement警告は出さない
// （全件再検証のたびに同じ警告が数十件並ぶノイズを防ぐ）。
// 代わりに登録簿(vocabulary.yaml)との乖離を集計1行で可視化する。
function lintWorldModel(osDir, { strict = false } = {}) {
  const events = loadEvents(osDir);
  const ids = new Set(events.map((e) => e.id));
  const vocab = loadVocabulary(osDir);
  const used = usedVocabulary(events);
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const assetCheck = makeAssetChecker(osDir);
  for (const st of events) {
    if (seen.has(st.id)) {
      // 同一idの再出現は現状スキーマでは想定しない（statusの更新はsupersedesで表現）
      warnings.push(`${st.id}: idが重複している（後の行が優先されない点に注意）`);
    }
    seen.add(st.id);
    const { errors: e, warnings: w } = validateStatement(st, { knownIds: ids, vocab, used, strict, assetCheck });
    errors.push(...e);
    warnings.push(...w);
  }
  // 使用実績はあるが未登録の語彙（使用数順）。strict時はvalidateStatementがエラー化済み
  if (!strict) {
    const tagCounts = {};
    for (const st of events) for (const t of st.tags || []) if (!vocab.tags.includes(t)) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const unregistered = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (unregistered.length) {
      const top = unregistered.slice(0, 10).map(([t, n]) => `${t}(${n})`).join(', ');
      warnings.push(
        `使用中だが未登録のtagが${unregistered.length}種: ${top}${unregistered.length > 10 ? ' …' : ''}` +
        '（安定した語彙は world_model/vocabulary.yaml への登録を検討）'
      );
    }
    // scopeは対象リポジトリ等の閉じた集合であり、未登録は語彙の揺れ（typo・命名不一致）の兆候。
    // tagsより強く可視化する（全件列挙する）。
    const scopeCounts = {};
    for (const st of events) for (const sc of st.scope || []) if (!vocab.scopes.includes(sc)) scopeCounts[sc] = (scopeCounts[sc] || 0) + 1;
    const unregScopes = Object.entries(scopeCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (unregScopes.length) {
      warnings.push(
        `使用中だが未登録のscope: ${unregScopes.map(([sc, n]) => `${sc}(${n})`).join(', ')}` +
        '（scopeは閉じた集合。world_model/vocabulary.yaml のscopesに登録するか、命名の揺れを修正せよ）'
      );
    }
  }
  return { errors, warnings, count: events.length };
}

module.exports = {
  STATEMENT_TYPES,
  STATUSES,
  LINK_ROLES,
  SNAPSHOT_SCHEMA_VERSION,
  isAssetRef,
  makeAssetChecker,
  eventsFile,
  loadEvents,
  loadVocabulary,
  validateStatement,
  assertStatements,
  recordStatement,
  buildSnapshot,
  rebuildSnapshot,
  getSnapshot,
  backfillScope,
  lintWorldModel,
};
