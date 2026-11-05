import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backup } from './parent-connect.mjs'

test('同じ設定の控えは再利用し、異なる復旧元と中断後の再開を保つ', t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable backup 日本語 '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'settings.json'), directory = join(root, 'backups')
  writeFileSync(file, '{"keep":"first"}')
  const first = backup([file], directory)
  assert.equal(backup([file], directory), first)
  writeFileSync(join(directory, '.pending.tar'), 'old interrupted archive')
  assert.equal(backup([file], directory), first)
  assert.equal(existsSync(join(directory, '.pending.tar')), false)
  writeFileSync(file, '{"keep":"second"}')
  const second = backup([file], directory)
  assert.notEqual(second, first)
  assert.equal(existsSync(first), true)
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.tar')).length, 2)
  if (process.platform !== 'win32') {
    assert.equal(statSync(second).mode & 0o777, 0o600)
    chmodSync(file, (statSync(file).mode & 0o777) === 0o600 ? 0o644 : 0o600)
    assert.notEqual(backup([file], directory), second)
  }
})

test('控える設定が無ければ生成せず、不正な入力ではtarを確定しない', t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable backup failure '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'backups')
  assert.equal(backup([join(root, 'absent')], directory), null)
  assert.equal(existsSync(directory), false)
  const invalid = join(root, 'directory'); mkdirSync(invalid)
  assert.throws(() => backup([invalid], directory), { code: 'PARENT_BACKUP_SOURCE_INVALID' })
  assert.deepEqual(readdirSync(directory), ['.transactions'])
})

test('破損・別入力・directory・証明なしの既控えは保持して保全を拒否する', t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable invalid backup '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const kind of ['corrupt', 'other-pair', 'directory', 'no-proof', 'checksum-directory']) {
    const project = join(root, kind); mkdirSync(project)
    const source = join(project, 'config.json'), directory = join(project, 'backups')
    writeFileSync(source, '{"keep":"original"}')
    const archive = backup([source], directory), checksum = `${archive}.sha256`
    if (kind === 'corrupt') writeFileSync(archive, 'damaged tar')
    if (kind === 'other-pair') {
      const other = join(project, 'other.json'); writeFileSync(other, 'different')
      const otherArchive = backup([other], directory)
      copyFileSync(otherArchive, archive); copyFileSync(`${otherArchive}.sha256`, checksum)
    }
    if (kind === 'directory') { rmSync(archive); mkdirSync(archive) }
    if (kind === 'no-proof') rmSync(checksum)
    if (kind === 'checksum-directory') { rmSync(checksum); mkdirSync(checksum) }
    const before = statSync(archive).isFile() ? readFileSync(archive) : null
    assert.throws(() => backup([source], directory), { code: 'PARENT_BACKUP_UNVERIFIED' }, kind)
    assert.equal(readFileSync(source, 'utf8'), '{"keep":"original"}')
    if (before) assert.deepEqual(readFileSync(archive), before)
    else assert.equal(statSync(archive).isDirectory(), true)
  }
})

test('tar失敗と作成中の入力変更は部分控えを残さず、設定更新を止める', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable tar failure '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'settings.json'), directory = join(root, 'backups'), binary = join(root, 'bin')
  mkdirSync(binary)
  const oldPath = process.env.PATH
  process.env.PATH = binary + ':' + oldPath
  try {
    for (const changed of [false, true]) {
      writeFileSync(file, 'original')
      writeFileSync(join(binary, 'tar'), `#!/bin/sh\nprintf partial > "$2"\n${changed ? 'printf changed > "$3"\nexit 0' : 'exit 23'}\n`, { mode: 0o755 })
      assert.throws(() => backup([file], directory), changed ? { code: 'PARENT_BACKUP_SOURCE_CHANGED' } : /Command failed/u)
      assert.equal(existsSync(join(directory, '.pending.tar')), false)
      assert.equal(readdirSync(directory).filter(name => name.endsWith('.tar')).length, 0)
      assert.equal(readFileSync(file, 'utf8'), changed ? 'changed' : 'original')
    }
  } finally { process.env.PATH = oldPath }
})
