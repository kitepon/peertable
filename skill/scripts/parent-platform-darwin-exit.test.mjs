import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { processIdentity } from './parent-platform.mjs'

test('macOSのps成功後lsof空出力は、本人の消失を確認した場合だけ終了になる', { skip: process.platform !== 'darwin' }, t => {
  const pid = 2140000000
  let alive = false, calls = []
  t.mock.method(childProcess, 'execFileSync', (file, args) => {
    calls.push({ file, args })
    if (file === '/usr/sbin/lsof') return ''
    if (args.includes('command=')) return '1 Tue Sep 29 05:13:09 2026 /bin/zsh -c prompt-submit'
    assert.deepEqual(args, ['-p', String(pid), '-o', 'pid='])
    if (alive) return `${pid}\n`
    throw Object.assign(new Error('終了済み'), { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  })
  syncBuiltinESMExports()
  try {
    assert.equal(processIdentity(pid), null)
    assert.equal(calls.length, 3)
    alive = true; calls = []
    assert.throws(() => processIdentity(pid), { code: 'PARENT_PROCESS_API_SCHEMA_INVALID' })
    assert.equal(calls.length, 3)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('macOSの生存確認APIの別異常を終了として扱わない', { skip: process.platform !== 'darwin' }, t => {
  t.mock.method(childProcess, 'execFileSync', (file, args) => {
    if (file === '/usr/sbin/lsof') return ''
    if (args.includes('command=')) return '1 Tue Sep 29 05:13:09 2026 /bin/zsh -c prompt-submit'
    throw Object.assign(new Error('権限異常'), { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('denied') })
  })
  syncBuiltinESMExports()
  try { assert.throws(() => processIdentity(2140000000), { code: 'PARENT_PROCESS_API_FAILED' }) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})
