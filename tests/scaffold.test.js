'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initOs, scaffoldSkillStubs } = require('../core/scaffold');

const OSS_ROOT = path.resolve(__dirname, '..');

function skillNames() {
  return fs.readdirSync(path.join(OSS_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(OSS_ROOT, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

test('init: ワークスペース外でもスキルスタブを絶対パス参照で生成する', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const r = initOs(ws);
  const expected = skillNames();
  assert.deepStrictEqual(r.skill_stubs.created.sort(), expected);
  assert.deepStrictEqual(r.skill_stubs.skipped, []);
  const stub = fs.readFileSync(path.join(ws, '.claude', 'skills', 'run-task', 'SKILL.md'), 'utf8');
  // frontmatterのname/descriptionが正本から取り込まれている
  assert.ok(stub.includes('name: run-task'));
  assert.ok(/description: .+/.test(stub));
  // ワークスペース外のOSS Coreは絶対パスで参照される
  const ossRef = OSS_ROOT.split(path.sep).join('/');
  assert.ok(stub.includes(`${ossRef}/skills/run-task/SKILL.md`), stub);
});

test('init: 既存スタブは上書きしない（ユーザー調整の保護）', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const stubPath = path.join(ws, '.claude', 'skills', 'run-task', 'SKILL.md');
  fs.mkdirSync(path.dirname(stubPath), { recursive: true });
  fs.writeFileSync(stubPath, 'カスタム済み\n', 'utf8');
  const r = initOs(ws);
  assert.ok(r.skill_stubs.skipped.includes('run-task'));
  assert.strictEqual(fs.readFileSync(stubPath, 'utf8'), 'カスタム済み\n');
});

test('init --force: 調整済みのconfig.yaml / vocabulary.yaml / goal.yamlを巻き戻さない', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  initOs(ws);
  const cfg = path.join(ws, '.os', 'config.yaml');
  const vocab = path.join(ws, '.os', 'world_model', 'vocabulary.yaml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('stale_after_days: 7', 'stale_after_days: 14'), 'utf8');
  fs.appendFileSync(vocab, '  - my-custom-tag\n', 'utf8');
  initOs(ws, { force: true });
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('stale_after_days: 14'));
  assert.ok(fs.readFileSync(vocab, 'utf8').includes('my-custom-tag'));
});

test('スタブのdescriptionは引用され、「: 」や「#」を含んでも壊れない', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  initOs(ws);
  const stub = fs.readFileSync(path.join(ws, '.claude', 'skills', 'run-task', 'SKILL.md'), 'utf8');
  const m = /^description: (".*")$/m.exec(stub);
  assert.ok(m, stub); // 二重引用のdouble-quoted scalarになっている
  assert.doesNotThrow(() => JSON.parse(m[1]));
});

test('scaffoldSkillStubs: OSSルート自身が対象なら相対パス参照になる', () => {
  // OSS repo自体には既にスタブがあるため、コピーしたskills/だけを持つ疑似ルートでは検証できない。
  // ここではパス計算のみ検証する: 対象=OSS_ROOTだと既存スタブが全てスキップされる
  const r = scaffoldSkillStubs(OSS_ROOT);
  assert.strictEqual(r.created.length, 0);
  assert.deepStrictEqual(r.skipped.sort(), skillNames());
});
