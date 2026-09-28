// 背景taskは親のnative toolが起動する。receipt作成だけではarmedにしない。
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { sameProcess, processIdentity, processDescendsFrom, shellCommand, hookCommand, windowsArgumentList, failure } from '../parent-platform.mjs'
import { PAGE_CHARS, renderDelivery, armParentState } from '../parent-delivery.mjs'

const entry = fileURLToPath(new URL('../parent-receive.mjs', import.meta.url))
export function waitReceipt(spool) {
  return spool.transact(state => {
    if (state.waiter && sameProcess(state.waiter.owner)) return { ...state.wait_receipt, already_running: true, native_tool: null }
    const receipt = state.wait_receipt && state.runtime === 'rearm_pending' && !state.waiter ? state.wait_receipt : {
      schema: 'peertable.parent-wait-process.v1', endpoint_id: spool.id, waiter_id: randomUUID(), generation: randomUUID(),
    }
    receipt.executable = process.execPath
    receipt.args = [entry, spool.project, spool.id, receipt.waiter_id, receipt.generation]
    receipt.windows_start_process_argument_list = windowsArgumentList(receipt.args)
    const command = process.platform === 'win32' ? hookCommand(receipt.executable, receipt.args) : shellCommand(receipt.executable, receipt.args)
    receipt.native_tool = state.harness === 'grok'
      ? { name: 'run_terminal_command', input: { command, description: 'Peertable親宛受信', background: true, timeout: 0 } }
      // モデル向けShell入力。hookが返すcwdはモデルAPIの引数ではない。
      : { name: 'Shell', input: { command, working_directory: spool.project, block_until_ms: 0, description: 'Peertable親宛受信' } }
    state.wait_receipt = receipt
    return receipt
  })
}

export async function bindNativeWait(spool, event, harness) {
  const state = spool.read(), expected = state.wait_receipt?.native_tool
  if (!expected) return false
  const tool = harness === 'grok' ? event.toolName : event.tool_name
  const input = harness === 'grok' ? event.toolInput : event.tool_input
  if (tool !== expected.name || input?.command !== expected.input.command) return false
  if (harness === 'cursor') {
    // CLI実測のcwdと公式hook仕様のworking_directoryを明示的に照合する。
    const directories = ['cwd', 'working_directory'].filter(key => Object.hasOwn(input, key))
    if (!directories.length || directories.some(key => input[key] !== expected.input.working_directory)) throw failure('PARENT_NATIVE_WAIT_INPUT_MISMATCH')
  }
  let output = harness === 'grok' ? event.toolResult : event.tool_output
  if (typeof output === 'string') { try { output = JSON.parse(output) } catch { throw failure('PARENT_NATIVE_WAIT_RESULT_INVALID') } }
  const task = harness === 'grok' ? output?.task_id : output?.shell_id
  const pid = output?.pid
  if (!task || !Number.isSafeInteger(pid)) throw failure('PARENT_NATIVE_WAIT_RESULT_INVALID')
  const deadline = Date.now() + 5000
  while (!spool.read().waiter && Date.now() < deadline) await delay(50)
  spool.transact(saved => {
    const waiter = saved.waiter
    if (!waiter || waiter.waiter_id !== saved.wait_receipt.waiter_id || waiter.generation !== saved.wait_receipt.generation || !sameProcess(waiter.owner)) throw failure('PARENT_NATIVE_WAIT_NOT_RUNNING')
    // POSIXは同じNode PID。PowerShell 7は公式task PIDの子としてNodeが動く。
    const taskOwner = processIdentity(pid)
    if (!taskOwner || !processDescendsFrom(waiter.owner, taskOwner)) throw failure('PARENT_NATIVE_WAIT_PROCESS_MISMATCH')
    waiter.native_task = { id: String(task), pid, process_identity: taskOwner, input: expected, hook_input: input, at: new Date().toISOString() }
    armParentState(saved)
  })
  await spool.publishHealth()
  return true
}

export async function backgroundReceive(spool, receipt, write) {
  await spool.assertCurrentEndpoint()
  const initial = spool.read()
  const waiter = spool.slot(`${initial.harness}_background`, receipt)
  if (!waiter) return { outcome: 'already_running' }
  const deadline = Date.now() + 86400000
  try {
    for (;;) {
      const state = spool.read()
      if (state.runtime === 'stopped' || !sameProcess(state.caller.owner)) return { outcome: 'stopped' }
      // 初期登録resultが確認されるまで本文を消費しない。
      const record = state.waiter?.native_task ? spool.claim(`${state.harness}_background`) : null
      if (record) {
        await spool.assertCurrentEndpoint()
        if (state.harness === 'grok') {
          spool.handoff(record)
          try {
            await write({ schema: 'peertable.parent-background-result.v1', endpoint_id: spool.id, waiter_id: waiter.waiter_id, generation: waiter.generation, outcome: 'ready', delivery_id: record.delivery_id, digest: record.digest })
          } catch (error) { spool.finish(record, { state: 'unknown', reason: 'PARENT_GROK_READY_OUTPUT_UNKNOWN' }); throw error }
        } else {
          const preview = String(record.event.body ?? '').length > PAGE_CHARS
          try {
            if (preview) spool.handoff(record)
            await write({ schema: 'peertable.parent-background-result.v1', endpoint_id: spool.id, waiter_id: waiter.waiter_id, generation: waiter.generation, outcome: 'ready', delivery_id: record.delivery_id, digest: record.digest,
              text: renderDelivery(state, record, { preview }), complete: !preview })
            if (!preview) spool.finish(record, { reason: 'cursor_native_background_output' })
          } catch (error) { spool.finish(record, { state: 'unknown', reason: 'PARENT_BACKGROUND_OUTPUT_UNKNOWN' }); throw error }
        }
        await spool.flushReceiptsAfterOutput()
        return { outcome: 'ready' }
      }
      if (Date.now() >= deadline) {
        await write({ schema: 'peertable.parent-background-result.v1', endpoint_id: spool.id, outcome: 'timeout', error_code: 'PARENT_RECEIVER_EXPIRED', rearm: { tool: 'parent_read', arguments: { endpoint_id: spool.id } } })
        return { outcome: 'timeout' }
      }
      await delay(250)
    }
  } finally {
    spool.releaseSlot(waiter, spool.read().runtime === 'stopped' ? 'stopped' : 'rearm_pending')
    // 終了したtaskのreceiptを再利用せず、次の世代を返せる状態にする。
    spool.update({ wait_receipt: null })
    await spool.publishHealth()
  }
}
