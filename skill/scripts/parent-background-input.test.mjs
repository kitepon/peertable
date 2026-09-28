import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ParentSpool } from './parent-delivery.mjs'
import { processIdentity } from './parent-platform.mjs'
import { waitReceipt, bindNativeWait } from './parent-receivers/background.mjs'

function fixture(t, harness = 'cursor') {
  const project = mkdtempSync(join(tmpdir(), 'peertable native input 日本語 '))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const spool = ParentSpool.create(project, { harness, caller: { owner: processIdentity(process.pid) } })
  spool.publishHealth = async () => {}
  return spool
}

test('Cursor receiptはhookのcwdでなくShell APIへ完成済み背景入力を渡す', t => {
  const spool = fixture(t), receipt = waitReceipt(spool)
  assert.deepEqual(receipt.native_tool, { name: 'Shell', input: {
    command: receipt.native_tool.input.command, working_directory: spool.project,
    block_until_ms: 0, description: 'Peertable親宛受信',
  } })
  assert.equal(Object.hasOwn(receipt.native_tool.input, 'cwd'), false)
})

test('Grok receiptは公開背景commandの入力を維持する', t => {
  const receipt = waitReceipt(fixture(t, 'grok'))
  assert.deepEqual(receipt.native_tool, { name: 'run_terminal_command', input: {
    command: receipt.native_tool.input.command, description: 'Peertable親宛受信', background: true, timeout: 0,
  } })
})

test('Cursor実hookのcwdと公式working_directoryをモデル入力と分けて実PIDへ束縛する', async t => {
  for (const directory of ['cwd', 'working_directory']) {
    const spool = fixture(t), receipt = waitReceipt(spool)
    spool.slot('cursor_background', receipt)
    const hookInput = { command: receipt.native_tool.input.command, [directory]: spool.project }
    assert.equal(await bindNativeWait(spool, { tool_name: 'Shell', tool_input: hookInput, tool_output: { shell_id: 'owned-task', pid: process.pid } }, 'cursor'), true)
    const saved = spool.read()
    assert.deepEqual(saved.waiter.native_task.input, receipt.native_tool)
    assert.deepEqual(saved.waiter.native_task.hook_input, hookInput)
    assert.equal(saved.runtime, 'armed')
    assert.equal(saved.waiter.native_task.process_identity.started, processIdentity(process.pid).started)
  }
})

test('同じcommandでもhookの作業directoryが欠落・不一致ならarmedへ進めない', async t => {
  const spool = fixture(t), receipt = waitReceipt(spool)
  spool.slot('cursor_background', receipt)
  for (const fields of [{}, { cwd: '別project' }, { working_directory: '別project' }, { cwd: spool.project, working_directory: '別project' }]) {
    await assert.rejects(bindNativeWait(spool, { tool_name: 'Shell', tool_input: { command: receipt.native_tool.input.command, ...fields }, tool_output: { shell_id: 'owned-task', pid: process.pid } }, 'cursor'), { code: 'PARENT_NATIVE_WAIT_INPUT_MISMATCH' })
    assert.equal(spool.read().runtime, 'rearm_pending')
    assert.equal(spool.read().waiter.native_task, null)
  }
  assert.equal(await bindNativeWait(spool, { tool_name: 'Shell', tool_input: { command: '無関係の作業', cwd: spool.project } }, 'cursor'), false)
})
