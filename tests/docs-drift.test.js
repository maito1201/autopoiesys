'use strict';
// scripts/check-docs-drift.js（sc-003の部分接地検出器）の検出力テスト。
// 検出器は「動いた」だけでは信用できない — 悪い状態を与えて実際に exit 1 に
// なることを確かめて初めて検出器である（golden taskのfixture検査と同じ思想）。
//
// fixtureは実リポジトリの対象ファイルのコピーで作る。合成ミニファイルでは
// 実物の書式（複数行の列挙・—で終わる散文・∪つきの表・自己遷移行）に対する
// 抽出が検証できず、抽出器が実物とズレても全テストが緑のままになるため。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-docs-drift.js');
const FILES = ['core/store.js', 'core/evaluate.js', 'core/failure.js', 'core/gap.js', 'cli/index.js', 'SCHEMA.md', 'docs/USAGE.md'];

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

// 変異が実際に適用されたことを検証して書き込む。素通りした変異は
// 「何も検出していないのに緑」というテスト自体の沈黙バグになる
function mustPatch(dir, rel, fn) {
  const before = read(dir, rel);
  const after = fn(before);
  assert.notStrictEqual(after, before, `${rel} への変異が適用されていない（置換対象の文字列が実物とズレた）`);
  fs.writeFileSync(path.join(dir, rel), after);
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-drift-'));
  for (const rel of FILES) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), dst);
  }
  // 既知の実在ドリフト（SCHEMA.md type一覧に lesson が無い。実装 core/store.js には有る）を
  // fixture内でだけ同期し、「違反ゼロのベースライン」を作る。実リポジトリ側の文書が
  // 後に修正されたら includes ガードで素通りし、このパッチは無害になる
  const schema = read(dir, 'SCHEMA.md');
  if (!/\|\s*lesson/.test(schema)) {
    mustPatch(dir, 'SCHEMA.md', (s) => s.replace(
      'unknown | decision | constraint | goal | outcome | failure | capability',
      'unknown | decision | constraint | goal | outcome | failure | capability | lesson'
    ));
  }
  return dir;
}

function run(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// fixture生成 → 変異 → 実行 → 後片付け
function withFixture(mutate, fn) {
  const dir = makeFixture();
  try {
    if (mutate) mutate(dir);
    return fn(run(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ベースライン: 同期済みfixtureは違反ゼロで、6検査すべてが実際に照合されている', () => {
  withFixture(null, (r) => {
    assert.strictEqual(r.code, 0, `違反ゼロのはずが exit ${r.code}:\n${r.out}`);
    // ok行の実在まで確認する — 抽出器が節を見失って検査0件のまま緑、という沈黙を許さない
    for (const label of ['ok: type', 'ok: links[].role', 'ok: reason', 'ok: 状態機械 state', 'ok: classification', 'ok: node cli/index.js', 'ok: gap classification']) {
      assert.ok(r.out.includes(label), `出力に「${label}」が無い:\n${r.out}`);
    }
  });
});

test('検出力: SCHEMA.mdのtype一覧から1語消すと exit 1（文書→実装方向）', () => {
  withFixture((dir) => {
    mustPatch(dir, 'SCHEMA.md', (s) => s.replace('relationship | observation | claim', 'relationship | claim'));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('NG:') && r.out.includes('observation'), r.out);
  });
});

test('検出力: 実装のLINK_ROLESに文書に無いroleを足すと exit 1（実装→文書方向）', () => {
  withFixture((dir) => {
    mustPatch(dir, 'core/store.js', (s) => s.replace("'caused_by', 'prevents']", "'caused_by', 'prevents', 'blocks_on']"));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('blocks_on'), r.out);
  });
});

test('検出力: SCHEMA.mdのreason一覧から1語消すと exit 1', () => {
  withFixture((dir) => {
    mustPatch(dir, 'SCHEMA.md', (s) => s.replace('insufficient_evidence | insufficient_sample', 'insufficient_evidence'));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('insufficient_sample'), r.out);
  });
});

test('検出力: 状態機械の表から行を消すと exit 1', () => {
  withFixture((dir) => {
    mustPatch(dir, 'SCHEMA.md', (s) => s.split('\n').filter((l) => !l.startsWith('| accepted_risk ')).join('\n'));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('accepted_risk'), r.out);
  });
});

test('検出力: classified行から分類を1語消すと exit 1', () => {
  withFixture((dir) => {
    mustPatch(dir, 'SCHEMA.md', (s) => s.replace('missing_decision_model, ', ''));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('missing_decision_model'), r.out);
  });
});

test('検出力: USAGE.mdに存在しないコマンドを書くと exit 1', () => {
  withFixture((dir) => {
    fs.appendFileSync(path.join(dir, 'docs', 'USAGE.md'), '\n```bash\nnode cli/index.js frobnicate --json\n```\n');
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('frobnicate'), r.out);
  });
});

test('検出力: 文書が参照するコマンドを実装から消すと exit 1', () => {
  withFixture((dir) => {
    // USAGE.mdが `node cli/index.js regression` を案内している前提で、実装側のキー名を変える
    mustPatch(dir, 'cli/index.js', (s) => s.replace('  regression(args) {', '  regressionX(args) {'));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('regression'), r.out);
  });
});

test('沈黙防止: 節見出しが変わって抽出できなくなったら「違反ゼロ」ではなく exit 1', () => {
  withFixture((dir) => {
    mustPatch(dir, 'SCHEMA.md', (s) => s.replace('## Statement', '## ステートメント'));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('見つからない'), r.out);
  });
});

// F010の予防: 分類語彙から1語（UNMET）が落ちると、目的層の未達がAVAILABLEに吸い込まれる
test('検出力: SCHEMA.mdのgap分類表からUNMET行を消すと exit 1', () => {
  withFixture((dir) => {
    const NL = String.fromCharCode(10);
    mustPatch(dir, 'SCHEMA.md', (s) => s.split(NL).filter((l) => !l.startsWith('| 4.5 | UNMET |')).join(NL));
  }, (r) => {
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('UNMET'), r.out);
  });
});
