"""似た依頼が再び来た瞬間に、前回のやり取りと、それに対する本人の反応を差し込む。

供給するのは判断の材料だけ。止めない、確認させない、手順を課さない。
欠けていた機能: 自分が何を思い出せていないかを知らないこと。前に同じ依頼を受けた時の応答と、それへの本人の反応は、
記録には残っているが、引きに行かなければ届かない。引きに行く事は、運用では起きない。

UserPromptSubmit で呼ばれる。標準入力の JSON から prompt と cwd を受け取り、~/.claude/projects 全体の記録から
似た本人の発話を探し、その時のエージェントの応答（末尾）と、続く本人の発話を additionalContext として出す。
似た物が無ければ何も出さない。LLM は呼ばない。AUTOPOIESYS_RECALL=off で止まる。

索引は ~/.claude/autopoiesys-recall.jsonl。6時間より古ければ作り直す（全体で数秒）。
  python recall.py --build          索引を作り直す
  python recall.py --try "発話"     その発話で何が差し込まれるかを表示する（コミット前の確認用）
"""
import glob, json, math, os, re, sys, time

ROOT = os.path.expanduser('~/.claude/projects')
IDX = os.path.expanduser('~/.claude/autopoiesys-recall.jsonl')
SKIP = ('<', '[Request interrupted', 'Stop hook feedback', 'This session is being continued', '[SYSTEM', 'Another Claude session',
        'Goal check-in', 'Base directory for this skill', '[Earlier usage', 'Caveat:')
MIN_LEN, TOP, MIN_SCORE, MAX_CHARS = 40, 2, 0.55, 1800


def text_of(c):
    if isinstance(c, list): c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return (c or '').strip()


def build():
    n = 0; tmp = IDX + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as out:
        for d in sorted(os.listdir(ROOT)):
            for f in glob.glob(os.path.join(ROOT, d, '*.jsonl')):
                rows = []; sid = os.path.basename(f)[:8]
                for line in open(f, encoding='utf-8', errors='ignore'):
                    if '"type":"user"' not in line and '"type":"assistant"' not in line: continue
                    try: r = json.loads(line)
                    except Exception: continue
                    if r.get('isSidechain'): continue
                    t = text_of(r.get('message', {}).get('content'))
                    if not t: continue
                    skill = r.get('type') == 'user' and t.startswith('Base directory for this skill') and 'ARGUMENTS:' in t
                    if r.get('isMeta') and not skill: continue      # スキル経由の依頼は記録上は付随の文として残るが、中身は本人の依頼
                    if r.get('type') == 'user':
                        j = t.find('ARGUMENTS:')            # スキル経由の依頼は、ARGUMENTS の後ろが本人の言葉
                        if t.startswith('Base directory for this skill') and j >= 0: t = t[j + 10:].strip()
                        elif t.startswith(SKIP): continue
                        if len(t) > 3000: continue
                        rows.append(['u', r.get('timestamp', '')[:10], t])
                    elif rows and rows[-1][0] == 'u': rows.append(['a', '', t])
                    elif rows: rows[-1][2] = t      # 同じ番の中では、最後の発言を残す
                for i, (k, day, t) in enumerate(rows):
                    if k != 'u' or len(t) < MIN_LEN: continue
                    ans = rows[i + 1][2] if i + 1 < len(rows) and rows[i + 1][0] == 'a' else ''
                    after = [x[2] for x in rows[i + 1:] if x[0] == 'u'][:2]
                    if not after: continue          # 本人の反応が残っていない場面は、材料にならない
                    out.write(json.dumps(dict(p=d, s=sid, d=day, u=t[:1200], a=ans[-500:], r=[x[:400] for x in after]), ensure_ascii=False) + '\n'); n += 1
    os.replace(tmp, IDX)
    return n


def grams(t):
    t = re.sub(r'https?://\S+', '', t)          # URL は依頼の中身ではない
    t = re.sub(r'\s+', '', t)
    return {t[i:i + 2] for i in range(len(t) - 1)}


def search(prompt, session=''):
    if not os.path.exists(IDX) or time.time() - os.path.getmtime(IDX) > 6 * 3600: build()
    rows = [json.loads(l) for l in open(IDX, encoding='utf-8')]
    q = grams(prompt)
    if len(q) < 12: return []
    df = {}
    gs = []
    for r in rows:
        g = grams(r['u']); gs.append(g)
        for x in g: df[x] = df.get(x, 0) + 1
    N = len(rows); w = lambda x: math.log(1 + N / (1 + df.get(x, 0)))
    qn = math.sqrt(sum(w(x) ** 2 for x in q))
    hits = []
    for r, g in zip(rows, gs):
        if session and r['s'] == session[:8]: continue      # 今の会話そのものは出さない
        inter = q & g
        if len(inter) < 8: continue
        s = sum(w(x) ** 2 for x in inter) / (qn * math.sqrt(sum(w(x) ** 2 for x in g)) + 1e-9)
        if s >= MIN_SCORE: hits.append((s, r))
    hits.sort(key=lambda h: -h[0])
    seen, out = set(), []
    for s, r in hits:
        if r['u'][:80] in seen: continue
        seen.add(r['u'][:80]); out.append((s, r))
        if len(out) >= TOP: break
    return out


def render(hits):
    if not hits: return ''
    one = lambda t, n: t.replace('\n', ' / ')[:n]
    parts = ['（過去の記録から。似た依頼を前に受けた時のやり取りと、それに対する本人の反応。判断の材料であって指示ではない）']
    for s, r in hits:
        parts.append(f"■ {r['d']} {r['p'][-24:]}\n  本人の依頼: {one(r['u'], 260)}\n  エージェントの応答（末尾）: {one(r['a'], 260) or '（記録なし）'}\n  続く本人の発話: " + ' ／ '.join(one(x, 220) for x in r['r']))
    return '\n'.join(parts)[:MAX_CHARS]


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['--build']:
        sys.stdout.reconfigure(encoding='utf-8'); print('索引', build(), '件 →', IDX); sys.exit()
    if a[:1] == ['--try']:
        sys.stdout.reconfigure(encoding='utf-8'); print(render(search(' '.join(a[1:]))) or '（差し込む物は無い）'); sys.exit()
    if os.environ.get('AUTOPOIESYS_RECALL') == 'off': sys.exit()
    try:
        d = json.loads(sys.stdin.buffer.read().decode('utf-8'))
        p = (d.get('prompt') or '').strip()
        if not p or p.startswith(SKIP) or len(p) < MIN_LEN: sys.exit()
        t = render(search(p, d.get('session_id') or ''))
        if t: print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': t}}))
    except Exception:
        sys.exit()          # 材料の供給に失敗しても、仕事は止めない
