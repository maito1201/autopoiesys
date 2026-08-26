'use strict';
// 依存ゼロのYAMLサブセットパーサ。対応範囲はSCHEMA.mdに明記。
// 対応: インデントによるマップ/リスト、"- " リスト項目、スカラー、引用文字列、
//       # コメント、| リテラルブロック、単一行フロースタイル {..} [..]
// 非対応（明示エラー）: アンカー(&)・エイリアス(*)・タグ(!)・複数ドキュメント

function parseYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const ctx = { lines };
  let i = skipBlank(ctx, 0);
  if (i >= lines.length) return null;
  if (stripComment(lines[i]).trim() === '---') i = skipBlank(ctx, i + 1);
  if (i >= lines.length) return null;
  const [value] = parseBlock(ctx, i, indentOf(ctx, i));
  return value;
}

function err(ctx, i, msg) {
  return new Error(`YAML ${i + 1}行目: ${msg}`);
}

function indentOf(ctx, i) {
  const line = ctx.lines[i];
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  if (line[n] === '\t') throw err(ctx, i, 'タブによるインデントは非対応');
  return n;
}

function isBlank(ctx, i) {
  return stripComment(ctx.lines[i]).trim() === '';
}

function skipBlank(ctx, i) {
  while (i < ctx.lines.length && isBlank(ctx, i)) i++;
  return i;
}

// 行を引用状態を追跡しながら走査し、引用の外にある文字だけ cb(c, i) に渡す。
// 引用は「値の開始位置（行頭・空白・: , [ { の直後）」でのみ開く —
// プレーンスカラー中のアポストロフィ（it's等）を引用開始と誤認しないため。
// 単引用内の '' と二重引用内の \" はエスケープとして扱う。
function scanOutsideQuotes(line, cb) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inS) {
      if (c === "'") {
        if (line[i + 1] === "'") i++;
        else inS = false;
      }
      continue;
    }
    if (inD) {
      if (c === '"' && line[i - 1] !== '\\') inD = false;
      continue;
    }
    const prev = i === 0 ? undefined : line[i - 1];
    const opener = prev === undefined || prev === ' ' || prev === ':' || prev === ',' || prev === '[' || prev === '{';
    if (c === "'" && opener) {
      inS = true;
      continue;
    }
    if (c === '"' && opener) {
      inD = true;
      continue;
    }
    if (cb(c, i) === false) return;
  }
}

function stripComment(line) {
  let cut = -1;
  scanOutsideQuotes(line, (c, i) => {
    if (c === '#' && (i === 0 || line[i - 1] === ' ')) {
      cut = i;
      return false;
    }
    return true;
  });
  return cut < 0 ? line : line.slice(0, cut);
}

// i行目（インデント=indent）から始まるブロックを解析し [値, 次の行index] を返す
function parseBlock(ctx, i, indent) {
  const content = stripComment(ctx.lines[i]).slice(indent).trimEnd();
  if (content === '-' || content.startsWith('- ')) return parseList(ctx, i, indent);
  return parseMap(ctx, i, indent, null);
}

// injected があれば最初のエントリとして処理する（"- key: value" 項目用）
function parseMap(ctx, i, indent, injected) {
  const obj = {};
  if (injected) {
    i = parseMapEntry(ctx, injected.lineIdx, indent, injected.content, obj, i);
  }
  for (;;) {
    i = skipBlank(ctx, i);
    if (i >= ctx.lines.length) break;
    const ind = indentOf(ctx, i);
    if (ind < indent) break;
    if (ind > indent) throw err(ctx, i, `予期しないインデント（${indent}を期待）`);
    const content = stripComment(ctx.lines[i]).slice(ind).trimEnd();
    if (content === '-' || content.startsWith('- ')) {
      throw err(ctx, i, 'マップと同じインデントにリスト項目は置けない');
    }
    i = parseMapEntry(ctx, i, indent, content, obj, i + 1);
  }
  return [obj, i];
}

// 1つの "key: value" エントリを処理して次の行indexを返す
function parseMapEntry(ctx, lineIdx, indent, content, obj, nextIdx) {
  const ci = findColon(content);
  if (ci < 0) throw err(ctx, lineIdx, `"key: value" 形式でない: ${content}`);
  const key = parseScalar(ctx, lineIdx, content.slice(0, ci).trim());
  const rest = content.slice(ci + 1).trim();
  let i = nextIdx;
  let value;
  if (rest === '') {
    const j = skipBlank(ctx, i);
    if (j < ctx.lines.length && indentOf(ctx, j) > indent) {
      [value, i] = parseBlock(ctx, j, indentOf(ctx, j));
    } else {
      value = null;
    }
  } else if (rest === '|' || rest === '|-') {
    [value, i] = parseLiteral(ctx, i, indent, rest === '|');
  } else {
    value = parseInlineValue(ctx, lineIdx, rest);
  }
  obj[String(key)] = value;
  return i;
}

function parseList(ctx, i, indent) {
  const arr = [];
  for (;;) {
    i = skipBlank(ctx, i);
    if (i >= ctx.lines.length) break;
    const ind = indentOf(ctx, i);
    if (ind !== indent) {
      if (ind < indent) break;
      throw err(ctx, i, `予期しないインデント（${indent}を期待）`);
    }
    const content = stripComment(ctx.lines[i]).slice(ind).trimEnd();
    if (!(content === '-' || content.startsWith('- '))) break;
    if (content === '-') {
      const j = skipBlank(ctx, i + 1);
      if (j < ctx.lines.length && indentOf(ctx, j) > indent) {
        const [v, next] = parseBlock(ctx, j, indentOf(ctx, j));
        arr.push(v);
        i = next;
      } else {
        arr.push(null);
        i = i + 1;
      }
      continue;
    }
    const m = /^-( +)(.*)$/.exec(content);
    const after = m[2].trimEnd();
    const itemIndent = indent + 1 + m[1].length;
    if (findColon(after) >= 0 && !isFlowOrQuoted(after)) {
      // "- key: value" → マップ項目。続く行（インデント=itemIndent）も同じマップ
      const [v, next] = parseMap(ctx, i + 1, itemIndent, { lineIdx: i, content: after });
      arr.push(v);
      i = next;
    } else {
      arr.push(parseInlineValue(ctx, i, after));
      i = i + 1;
    }
  }
  return [arr, i];
}

// 引用やフローで始まる値はマップ項目とみなさない（"- 'a: b'" 等）
function isFlowOrQuoted(s) {
  return s[0] === '"' || s[0] === "'" || s[0] === '[' || s[0] === '{';
}

// 引用の外にある、値区切りとして有効なコロン位置（": " または行末の ":"）
function findColon(s) {
  let pos = -1;
  scanOutsideQuotes(s, (c, i) => {
    if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) {
      pos = i;
      return false;
    }
    return true;
  });
  return pos;
}

function parseLiteral(ctx, i, keyIndent, keepFinal) {
  const raw = [];
  let blockIndent = -1;
  while (i < ctx.lines.length) {
    const line = ctx.lines[i];
    if (line.trim() === '') {
      raw.push('');
      i++;
      continue;
    }
    const ind = indentOf(ctx, i);
    if (ind <= keyIndent) break;
    if (blockIndent < 0) blockIndent = ind;
    raw.push(line.slice(Math.min(blockIndent, ind)));
    i++;
  }
  while (raw.length && raw[raw.length - 1] === '') raw.pop();
  let s = raw.join('\n');
  if (keepFinal && s !== '') s += '\n';
  return [s, i];
}

function parseInlineValue(ctx, lineIdx, s) {
  if (s[0] === '[' || s[0] === '{') {
    const [v, pos] = parseFlow(ctx, lineIdx, s, 0);
    if (s.slice(pos).trim() !== '') throw err(ctx, lineIdx, `フロー値の後に余分な文字: ${s.slice(pos)}`);
    return v;
  }
  return parseScalar(ctx, lineIdx, s);
}

function parseScalar(ctx, lineIdx, s) {
  s = s.trim();
  if (s === '') return null;
  if (s[0] === '"') {
    if (s[s.length - 1] !== '"' || s.length < 2) throw err(ctx, lineIdx, `閉じていない二重引用: ${s}`);
    return unescapeDouble(s.slice(1, -1));
  }
  if (s[0] === "'") {
    if (s[s.length - 1] !== "'" || s.length < 2) throw err(ctx, lineIdx, `閉じていない引用: ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (s[0] === '&' || s[0] === '*' || s[0] === '!') {
    throw err(ctx, lineIdx, `アンカー/エイリアス/タグは非対応: ${s}`);
  }
  return s;
}

function unescapeDouble(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const c = s[i + 1];
      if (c === 'n') out += '\n';
      else if (c === 't') out += '\t';
      else if (c === '"') out += '"';
      else if (c === '\\') out += '\\';
      else out += '\\' + c; // 正規表現パターン等のためにそのまま保持
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

function parseFlow(ctx, lineIdx, s, pos) {
  pos = skipWs(s, pos);
  if (s[pos] === '[') {
    pos++;
    const arr = [];
    pos = skipWs(s, pos);
    if (s[pos] === ']') return [arr, pos + 1];
    for (;;) {
      let v;
      [v, pos] = parseFlowValue(ctx, lineIdx, s, pos);
      arr.push(v);
      pos = skipWs(s, pos);
      if (s[pos] === ',') {
        pos = skipWs(s, pos + 1);
        continue;
      }
      if (s[pos] === ']') return [arr, pos + 1];
      throw err(ctx, lineIdx, `"]" が見つからない: ${s}`);
    }
  }
  if (s[pos] === '{') {
    pos++;
    const obj = {};
    pos = skipWs(s, pos);
    if (s[pos] === '}') return [obj, pos + 1];
    for (;;) {
      let keyEnd = pos;
      if (s[pos] === "'" || s[pos] === '"') {
        keyEnd = skipQuoted(s, pos);
      }
      while (keyEnd < s.length && s[keyEnd] !== ':') keyEnd++;
      if (keyEnd >= s.length) throw err(ctx, lineIdx, `":" が見つからない: ${s}`);
      const key = parseScalar(ctx, lineIdx, s.slice(pos, keyEnd).trim());
      let v;
      [v, pos] = parseFlowValue(ctx, lineIdx, s, keyEnd + 1);
      obj[String(key)] = v;
      pos = skipWs(s, pos);
      if (s[pos] === ',') {
        pos = skipWs(s, pos + 1);
        continue;
      }
      if (s[pos] === '}') return [obj, pos + 1];
      throw err(ctx, lineIdx, `"}" が見つからない: ${s}`);
    }
  }
  throw err(ctx, lineIdx, `フロー値でない: ${s.slice(pos)}`);
}

// pos が引用の開始なら、閉じ引用の直後の位置を返す（'' と \" のエスケープ対応）
function skipQuoted(s, pos) {
  const q = s[pos];
  let i = pos + 1;
  while (i < s.length) {
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (q === '"' && s[i - 1] === '\\') {
        i++;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

function parseFlowValue(ctx, lineIdx, s, pos) {
  pos = skipWs(s, pos);
  if (s[pos] === '[' || s[pos] === '{') return parseFlow(ctx, lineIdx, s, pos);
  let end = pos;
  if (s[pos] === "'" || s[pos] === '"') end = skipQuoted(s, pos);
  while (end < s.length && s[end] !== ',' && s[end] !== ']' && s[end] !== '}') end++;
  return [parseScalar(ctx, lineIdx, s.slice(pos, end).trim()), end];
}

function skipWs(s, pos) {
  while (pos < s.length && s[pos] === ' ') pos++;
  return pos;
}

module.exports = { parseYaml };
