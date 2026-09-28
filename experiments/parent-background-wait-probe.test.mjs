import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./parent-background-wait-probe.mjs', import.meta.url))
const run = (mode, root, ...args) => {
  const child = spawn(process.execPath, [script, mode, root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const completed = new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  return { child, completed }
}

test('背景waitの1slot、本文保持、完了後の2回目登録', async t => {
  const root = await mkdtemp(join(tmpdir(), 'peertable background test '))
  const children = []
  t.after(async () => { for (const child of children) child.kill(); await rm(root, { recursive: true, force: true }) })
  for (const id of ['1', '2']) {
    const waiter = run('wait', root)
    children.push(waiter.child)
    // 外部processがslotを登録したことを待ち、起動要求だけを成功にしない。
    let armed = false
    for (let i = 0; i < 100; i++) {
      try { await readFile(join(root, 'background-slot/owner.json')); armed = true; break } catch (error) { if (error.code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert(armed, '受信processがslotを確保する')
    const duplicate = await run('wait', root).completed
    assert.notEqual(duplicate.code, 0)
    assert.match(duplicate.stderr, /PROBE_SLOT_BUSY/)
    assert.equal(duplicate.stdout, '')
    const body = `符号${id} 日本語\n改行 "引用" ` + '長文'.repeat(3000)
    assert.equal((await run('inject', root, id, body).completed).code, 0)
    const delivered = await waiter.completed
    assert.equal(delivered.code, 0)
    const result = JSON.parse(delivered.stdout)
    assert.equal(result.seq, id)
    assert.equal(result.body, body)
    assert.equal(result.outcome, 'message')
  }
})
