// Linuxの実行中inodeを使うOS境界試験。受信の製品実機証拠には流用しない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processIdentity, processHarness, sameProcess } from './parent-platform.mjs'

test('更新でunlinkされた生存中binaryは本人の分類と実行可能なinodeを保持する', { skip: process.platform !== 'linux' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-unlinked-executable-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const name of ['claude.exe', 'codex']) {
    const file = join(dir, name)
    copyFileSync(process.execPath, file)
    const child = spawn(file, ['-e', 'setTimeout(()=>{},300000)'], { stdio: 'ignore' })
    try {
      await once(child, 'spawn')
      const before = processIdentity(child.pid)
      unlinkSync(file)
      const after = processIdentity(child.pid)
      assert.equal(sameProcess(after), true)
      assert.equal(after.started, before.started)
      assert.equal(processHarness(after), name === 'codex' ? 'codex' : 'claude')
      assert.equal(after.executable, `/proc/${child.pid}/exe`)
      assert.equal(execFileSync(after.executable, ['--version'], { encoding: 'utf8' }).trim(), process.version)
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended }
    }
  }
})
