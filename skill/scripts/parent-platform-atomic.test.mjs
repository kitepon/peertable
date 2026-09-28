import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, openSync, closeSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicJson, readJson } from './parent-platform.mjs'

test('読取り中の旧fileを保ち、Unicodeと長いpathのJSONをatomicに置換する', t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable atomic 日本語 '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, ...Array.from({ length: 7 }, (_, i) => `${i}-${'名前'.repeat(16)}`))
  const file = join(dir, '親の状態😀.json'), original = { revision: 0, body: '旧本文\r\n<&>😀' }
  atomicJson(file, original)
  const reader = openSync(file, 'r')
  try {
    for (let revision = 1; revision <= 20; revision++) {
      const next = { revision, body: '新本文\r\n<&>😀'.repeat(revision) }
      atomicJson(file, next)
      assert.deepEqual(readJson(file), next)
    }
    assert.deepEqual(JSON.parse(readFileSync(reader, 'utf8')), original)
  } finally { closeSync(reader) }
  assert.deepEqual(readdirSync(dir), ['親の状態😀.json'])
})

test('OSの置換失敗は原errorを返し、別経路で成功にしない', t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable atomic error '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const destination = join(root, 'directory.json')
  mkdirSync(destination)
  assert.throws(() => atomicJson(destination, { body: '保存できない本文' }), error =>
    process.platform === 'win32' ? error.code === 'PARENT_ATOMIC_REPLACE_FAILED' && Number.isInteger(error.win32_error)
      : error.code === 'EISDIR' || error.code === 'ENOTDIR')
  assert.equal(readdirSync(root).filter(name => name.endsWith('.tmp')).length, 1)
})
