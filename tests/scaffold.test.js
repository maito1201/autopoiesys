'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initOs, syncSkills } = require('../core/scaffold');

const OSS_ROOT = path.resolve(__dirname, '..');

function skillNames() {
  return fs.readdirSync(path.join(OSS_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(OSS_ROOT, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

function destPath(ws, name) {
  return path.join(ws, '.claude', 'skills', name, 'SKILL.md');
}

test('init: スキルは正本の内容ごと生成される（正本への余分なReadを強制しない）', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const r = initOs(ws);
  assert.deepStrictEqual(r.skill_stubs.created.sort(), skillNames());
  assert.deepStrictEqual(r.skill_stubs.skipped, []);
  const generated = fs.readFileSync(destPath(ws, 'run-task'), 'utf8');
  const canonical = fs.readFileSync(path.join(OSS_ROOT, 'skills', 'run-task', 'SKILL.md'), 'utf8');
  // frontmatterは正本のまま（先頭になければClaude Codeがスキルとして認識しない）
  assert.ok(generated.startsWith('---\nname: run-task\n'), generated.slice(0, 80));
  // 本文が正本ごと入っており、「正本を読みに行け」という参照ではない
  assert.ok(generated.includes('## 手順'), '正本の本文が含まれていない');
  assert.ok(!/正本は .*をReadで読み/.test(generated), '参照スタブに退行している');
  // 生成物であることが読み手にもツールにも分かる
  assert.ok(generated.includes('autopoiesys:generated source=skills/run-task/SKILL.md'));
  // マーカー行以外は正本と一致する
  assert.strictEqual(generated.split('\n').filter((l) => !l.includes('autopoiesys:generated')).join('\n').trim(),
    canonical.trim());
});

test('init: ユーザーが書いたスキルは上書きしない', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const p = destPath(ws, 'run-task');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'カスタム済み\n', 'utf8');
  const r = initOs(ws);
  assert.ok(r.skill_stubs.skipped.includes('run-task'));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'カスタム済み\n');
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

test('skills sync --check: 正本とのズレを書き換えずに検出し、syncで解消する', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  initOs(ws);
  assert.deepStrictEqual(syncSkills(ws, { check: true }).stale, []);
  const p = destPath(ws, 'run-task');
  const drifted = fs.readFileSync(p, 'utf8') + '\n古い手順が残っている\n';
  fs.writeFileSync(p, drifted, 'utf8');
  const checked = syncSkills(ws, { check: true });
  assert.deepStrictEqual(checked.stale, ['run-task']);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), drifted, 'checkは書き換えてはならない');
  const synced = syncSkills(ws);
  assert.deepStrictEqual(synced.updated, ['run-task']);
  assert.ok(!fs.readFileSync(p, 'utf8').includes('古い手順が残っている'));
});

test('skills sync: 参照スタブ時代の生成物は正本の内容へ置き換える', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  const p = destPath(ws, 'run-task');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '---\nname: run-task\n---\n\nこのSkillの正本は `skills/run-task/SKILL.md` である。\n', 'utf8');
  const r = syncSkills(ws);
  assert.deepStrictEqual(r.updated, ['run-task']);
  assert.ok(fs.readFileSync(p, 'utf8').includes('## 手順'));
});
