#!/usr/bin/env node
// 親のnative背景toolだけが起動する、1slotの構造化受信入口。
import { ParentSpool } from './parent-delivery.mjs'
import { backgroundReceive } from './parent-receivers/background.mjs'
const [project, endpoint, waiter_id, generation] = process.argv.slice(2)
const write = value => new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()))
try {
  const result = await backgroundReceive(new ParentSpool(project, endpoint), { waiter_id, generation }, write)
  if (result.outcome === 'timeout') process.exitCode = 3
  else if (['stopped', 'already_running'].includes(result.outcome)) {
    await write({ schema: 'peertable.parent-background-result.v1', endpoint_id: endpoint, ...result, error_code: result.outcome === 'stopped' ? 'PARENT_RECEIVER_STOPPED' : 'PARENT_WAIT_ALREADY_RUNNING' })
    process.exitCode = 4
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ schema: 'peertable.parent-background-result.v1', outcome: 'failed', error_code: error.code ?? 'PARENT_RECEIVE_FAILED', detail: error.message })}\n`)
  process.exitCode = 1
}
