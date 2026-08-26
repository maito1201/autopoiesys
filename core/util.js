'use strict';
// 共通ユーティリティ。決定性の規約（UTF-8 / LF / キーソート済みJSON）はここで一元化する。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

function stableStringify(v, indent = 0) {
  return JSON.stringify(sortValue(v), null, indent);
}

// 概算トークン（4文字=1トークン）。契約強制に使う保守的な近似。
function estimateTokens(str) {
  return Math.ceil(str.length / 4);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// 症状文の粗い指紋。小文字化+全空白除去（言い回しの揺れまでは吸収しない）。
function fingerprint(text) {
  const normalized = String(text).toLowerCase().replace(/\s+/g, '');
  return sha1(normalized).slice(0, 8);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${file}:${i + 1}: 不正なJSON行: ${e.message}`);
    }
  }
  return out;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, stableStringify(obj) + '\n', 'utf8');
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWriteFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  // WindowsではAVスキャナ・インデクサが対象を開いている瞬間にrenameがEPERM/EBUSYになる。
  // 短い後退リトライで吸収し、それでも失敗したらtmpを削除してから投げる（孤児を残さない）。
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 5) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // tmp削除失敗は元エラーを優先
        }
        throw e;
      }
      sleepMs(20 * attempt);
    }
  }
}

// BOM/UTF-16を検出してテキストを読む。評価対象の成果物はPowerShell等が
// UTF-16LEやBOM付きUTF-8で書くことがあり、utf8固定読取は偽FAILの原因になる。
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    b.swap16();
    return b.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

function readTextFile(file) {
  return decodeText(fs.readFileSync(file));
}

// 既存ID群から prefix + ゼロ埋め連番の次IDを決める（単一ライター前提）。
function nextId(prefix, existingIds, pad = 3) {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(pad, '0');
}

// cwdから上へ .os/ を探す。見つからなければnull。
function findOsDir(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const cand = path.join(dir, '.os');
    if (fs.existsSync(path.join(cand, 'config.yaml'))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

module.exports = {
  stableStringify,
  estimateTokens,
  nowIso,
  sha1,
  fingerprint,
  readJsonl,
  appendJsonl,
  atomicWriteFile,
  readTextFile,
  decodeText,
  nextId,
  findOsDir,
};
