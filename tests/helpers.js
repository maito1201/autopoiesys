'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initOs } = require('../core/scaffold');

// 一時ディレクトリに .os/ を生成して返す
function makeOs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-'));
  const { osDir } = initOs(root);
  return { root, osDir };
}

function write(base, rel, content) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function statement(id, type, body, extra = {}) {
  return {
    id,
    ts: '2026-08-26T00:00:00Z',
    type,
    body,
    status: extra.status || 'fact',
    provenance: { source: 'test', method: 'deterministic' },
    ...extra,
  };
}

module.exports = { makeOs, write, statement };
