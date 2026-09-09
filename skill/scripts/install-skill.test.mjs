import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { inspectSkill, installSkill } from './install-skill.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-skill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home with spaces')
  mkdirSync(home)
  function pkg(name, version) {
    const root = join(dir, name)
    mkdirSync(join(root, 'skill'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'peertable', version }))
    writeFileSync(join(root, 'skill', 'SKILL.md'), `---\nname: peertable\n---\n${version}\n`)
    return root
  }
  return { home, pkg, root: pkg('package 1', '1.0.0') }
}

test('初回配置と再実行で同じskillを公開しAI設定とprojectを保持する', t => {
  const { root, home } = fixture(t)
  const targets = ['claude', 'codex', 'grok', 'cursor']
  for (const client of targets) {
    mkdirSync(join(home, `.${client}`))
    writeFileSync(join(home, `.${client}`, 'config.toml'), '# 独自設定\n')
  }
  mkdirSync(join(home, 'project', '.team'), { recursive: true })
  writeFileSync(join(home, 'project', '.team', 'setup-state.json'), '{"room":"既存room"}\n')
  const first = installSkill({ root, home })
  assert.equal(first.status, 'ready')
  assert.deepEqual(first.targets.map(entry => entry.status), targets.map(() => 'installed'))
  const inodes = first.targets.map(entry => lstatSync(entry.path).ino)
  const second = installSkill({ root, home })
  assert.deepEqual(second.targets.map(entry => entry.status), targets.map(() => 'current'))
  assert.deepEqual(second.targets.map(entry => lstatSync(entry.path).ino), inodes)
  for (const entry of first.targets) {
    assert.equal(realpathSync(entry.path), realpathSync(join(root, 'skill')))
    assert.equal(readFileSync(join(home, `.${entry.client}`, 'config.toml'), 'utf8'), '# 独自設定\n')
  }
  assert.equal(readFileSync(join(home, 'project', '.team', 'setup-state.json'), 'utf8'), '{"room":"既存room"}\n')
})

test('更新は旧Peertableへの手動リンクを移行し旧sourceを保持する', t => {
  const { root, home, pkg } = fixture(t)
  installSkill({ root, home, targets: ['codex'] })
  const updatedRoot = pkg('package 2', '2.0.0')
  const result = installSkill({ root: updatedRoot, home, targets: ['codex'] })
  assert.equal(result.targets[0].status, 'updated')
  assert.equal(readFileSync(join(home, '.codex', 'skills', 'peertable', 'SKILL.md'), 'utf8'), '---\nname: peertable\n---\n2.0.0\n')
  assert.equal(readFileSync(join(root, 'skill', 'SKILL.md'), 'utf8'), '---\nname: peertable\n---\n1.0.0\n')
})

test('独自ディレクトリとの衝突は全導入先への書込みより前に止まる', t => {
  const { root, home } = fixture(t)
  const custom = join(home, '.codex', 'skills', 'peertable')
  mkdirSync(custom, { recursive: true })
  writeFileSync(join(custom, 'SKILL.md'), '利用者の独自skill')
  assert.throws(() => installSkill({ root, home, targets: ['claude', 'codex'] }), { code: 'PEERTABLE_SKILL_CONFLICT' })
  assert.equal(readFileSync(join(custom, 'SKILL.md'), 'utf8'), '利用者の独自skill')
  assert.throws(() => lstatSync(join(home, '.claude')), { code: 'ENOENT' })
})

test('別製品へのリンクは上書きせず、診断は読み取りだけを行う', t => {
  const { root, home } = fixture(t)
  const custom = join(home, 'custom')
  mkdirSync(custom)
  const destination = join(home, '.grok', 'skills', 'peertable')
  mkdirSync(join(home, '.grok', 'skills'), { recursive: true })
  symlinkSync(custom, destination, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(inspectSkill({ root, home }).targets[0].status, 'conflict')
  assert.throws(() => installSkill({ root, home }), { code: 'PEERTABLE_SKILL_CONFLICT' })
  assert.equal(realpathSync(destination), realpathSync(custom))
})

test('未検出AIを作らず明示targetだけを導入する', t => {
  const { root, home } = fixture(t)
  assert.equal(installSkill({ root, home }).status, 'not_detected')
  assert.throws(() => installSkill({ root, home, targets: ['unknown'] }), { code: 'PEERTABLE_SKILL_TARGET_UNKNOWN' })
  assert.equal(installSkill({ root, home, targets: ['cursor'] }).targets[0].client, 'cursor')
  assert.throws(() => lstatSync(join(home, '.codex')), { code: 'ENOENT' })
})
