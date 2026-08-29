'use strict';
// config.yaml の routing 表を、実際のモデル選択に接続する決定的関数（LLMゼロ）。
// 宣言されているだけで誰も参照しない表は運用では守られない。tier を「自己申告」ではなく
// 表から導出し、なぜその tier になったかの根拠文字列を必ず返す。

const DEFAULT_TIER = 'T2'; // どの use_for にも当たらないときの既定（中位モデル）
const ESCALATED_TIER = 'T3';

// routing 表から「purpose → tier」の対応を作る。escalation はtier定義ではないので除く。
// キー名を T1/T2/T3 に決め打ちせず、use_for を持つ全エントリを見る
// （表を増やしたときにコード側が黙って無視することを防ぐ）。
function tierEntries(routing) {
  return Object.keys(routing || {})
    .filter((k) => k !== 'escalation')
    .sort()
    .map((tier) => [tier, routing[tier]])
    .filter(([, v]) => v && typeof v === 'object' && Array.isArray(v.use_for));
}

function modelOf(routing, tier) {
  const v = routing && routing[tier];
  if (typeof v === 'string') return v;
  return v && v.model ? v.model : null;
}

function toList(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s)).filter(Boolean);
}

// cfg.routing と {purpose, signals} から推奨tierを決める。
// 優先順位: ①escalationシグナルに該当 → T3 ②purposeがuse_forに載る tier ③既定（T2）
// 戻り値: { tier, model, reason, escalated, matched_signals, unknown_signals }
function recommendTier(cfg, { purpose, signals } = {}) {
  const routing = (cfg && cfg.routing) || null;
  const sigs = toList(signals);
  if (!routing) {
    return {
      tier: DEFAULT_TIER,
      model: null,
      reason: `config.yaml に routing 表が無いため既定の ${DEFAULT_TIER}`,
      escalated: false,
      matched_signals: [],
      unknown_signals: sigs,
    };
  }

  const escalation = toList(routing.escalation);
  const matched = sigs.filter((s) => escalation.includes(s));
  const unknown = sigs.filter((s) => !escalation.includes(s));

  const p = purpose ? String(purpose) : '';
  const hit = p ? tierEntries(routing).find(([, v]) => v.use_for.map(String).includes(p)) : undefined;
  const purposeTier = hit ? hit[0] : null;
  const purposePart = purposeTier
    ? `purpose "${p}" は ${purposeTier}.use_for に含まれる`
    : p
      ? `purpose "${p}" はどの tier の use_for にも無い`
      : 'purpose 未指定';
  // 表に無いシグナルは黙って無視しない（綴り違いが「昇格したつもり」を生む）
  const unknownPart = unknown.length ? `。escalation 表に無いシグナル: ${unknown.join(', ')}` : '';

  if (matched.length) {
    const verb = purposeTier === ESCALATED_TIER ? '既に' : `${purposeTier || DEFAULT_TIER} から`;
    return {
      tier: ESCALATED_TIER,
      model: modelOf(routing, ESCALATED_TIER),
      reason: `escalation シグナル ${matched.join(', ')} に該当するため ${verb} ${ESCALATED_TIER}（${purposePart}）${unknownPart}`,
      escalated: true,
      matched_signals: matched,
      unknown_signals: unknown,
    };
  }

  if (purposeTier) {
    return {
      tier: purposeTier,
      model: modelOf(routing, purposeTier),
      reason: `${purposePart}。escalation シグナル該当なし${unknownPart}`,
      escalated: false,
      matched_signals: [],
      unknown_signals: unknown,
    };
  }

  const noHit = p
    ? `purpose "${p}" はどの tier の use_for にも無いため既定の ${DEFAULT_TIER}`
    : `purpose 未指定のため既定の ${DEFAULT_TIER}`;
  return {
    tier: DEFAULT_TIER,
    model: modelOf(routing, DEFAULT_TIER),
    reason: `${noHit}${unknownPart}`,
    escalated: false,
    matched_signals: [],
    unknown_signals: unknown,
  };
}

module.exports = { recommendTier, DEFAULT_TIER, ESCALATED_TIER };
