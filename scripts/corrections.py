"""Claude Code の記録から、本人が打った短い発話だけを日付つきで取り出す（jq 不要）。
使い方: python corrections.py <~/.claude/projects 配下のディレクトリ>... [--max 300] [--since YYYY-MM-DD]"""
import glob, json, os, sys
sys.stdout.reconfigure(encoding='utf-8')
a = sys.argv[1:]; mx, since, dirs = 300, '0000-00-00', []
while a:
    x = a.pop(0)
    if x == '--max': mx = int(a.pop(0))
    elif x == '--since': since = a.pop(0)
    else: dirs.append(x)
if not dirs: sys.exit('usage: corrections.py <project-log-dir>... [--max N] [--since YYYY-MM-DD]')
SKIP = ('<', '[', '/', '#', '|', '`', '-', 'Stop hook feedback', 'This session is being continued', 'Another Claude session', 'Goal check-in', 'Base directory for this skill', 'Caveat:')
out = set()
for d in dirs:
    proj = os.path.basename(os.path.normpath(d))
    for f in glob.glob(os.path.join(d, '*.jsonl')):
        for line in open(f, encoding='utf-8', errors='ignore'):
            if '"type":"user"' not in line: continue
            try: r = json.loads(line)
            except Exception: continue
            if r.get('type') != 'user' or r.get('isSidechain') or r.get('isMeta'): continue
            c = r.get('message', {}).get('content')
            if isinstance(c, list): c = ' '.join(x.get('text', '') for x in c if x.get('type') == 'text')
            c = (c or '').strip(); day = r.get('timestamp', '')[:10]
            if not (6 < len(c) <= mx) or c.startswith(SKIP) or day < since: continue
            out.add(f"{day}\t{proj}\t{c.replace(chr(10), ' / ')}")
print('\n'.join(sorted(out)))
