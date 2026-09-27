import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from './aiterm-client.mjs'
import { deliveryFailureCode, memberDeliveryMode } from './wakeup-delivery.mjs'

const modes = ['sent', 'agent_dispatch', 'agent_steer']
const tool = {
  name: 'pty_send',
  inputSchema: { properties: { session_id: {}, text: {}, enter: {} } },
  outputSchema: { properties: {
    schema: { const: 'aiterm.pty-send-result.v1' }, mode: { enum: modes },
  } },
}

test('統合pty_sendの公開schemaだけをready条件にする', async () => {
  const client = new AitermClient()
  client.connected = Promise.resolve()
  client.client = { listTools: async () => ({ tools: [tool] }) }
  await client.requireUnifiedSend()
  for (const broken of [
    [],
    [{ ...tool, outputSchema: { properties: { schema: { const: 'aiterm.pty-send-result.v1' }, mode: { enum: ['sent', 'agent_dispatch'] } } } }],
    [{ ...tool, inputSchema: { properties: { session_id: {}, text: {} } } }],
  ]) {
    client.client = { listTools: async () => ({ tools: broken }) }
    await assert.rejects(client.requireUnifiedSend(), { code: 'PEERTABLE_AITERM_CONTRACT_UNAVAILABLE' })
  }
})

test('新規ターンと差し込みを受理し、waiterやcursorの有無で差し込みを拒まない', () => {
  assert.equal(memberDeliveryMode({ schema: 'aiterm.pty-send-result.v1', mode: 'agent_dispatch', submit_residue: false }), 'agent_dispatch')
  assert.equal(memberDeliveryMode({ schema: 'aiterm.pty-send-result.v1', mode: 'agent_steer', event_cursor: null, wait_process: null, submit_residue: null }), 'agent_steer')
})

test('素送信、残留、schema違反、未知modeを配達成功にしない', () => {
  for (const receipt of [
    { schema: 'aiterm.pty-send-result.v1', mode: 'sent' },
    { schema: 'aiterm.pty-send-result.v1', mode: 'agent_dispatch', submit_residue: true },
    { schema: 'aiterm.agent-steer.v1', mode: 'agent_steer' },
    { schema: 'aiterm.pty-send-result.v1', mode: 'future' },
    null,
  ]) assert.throws(() => memberDeliveryMode(receipt), { deliveryUncertain: true })
})

test('既知の成否不明は識別し、文字列の部分一致を再送判断に使わない', () => {
  assert.equal(deliveryFailureCode(new Error('STEER_NOT_QUEUED vendor=grok')), 'STEER_NOT_QUEUED')
  assert.equal(deliveryFailureCode(new Error('aiterm: STEER_NOT_QUEUED vendor=grok')), 'STEER_NOT_QUEUED')
  assert.equal(deliveryFailureCode(new Error('STEER_STILL_QUEUED vendor=cursor')), 'STEER_STILL_QUEUED')
  assert.equal(deliveryFailureCode(new Error('aiterm: STEER_STILL_QUEUED vendor=cursor')), 'STEER_STILL_QUEUED')
  assert.equal(deliveryFailureCode(new Error('submit_residue=true vendor=cursor')), 'DELIVERY_STUCK')
  assert.equal(deliveryFailureCode(new Error('aiterm: submit_residue=true vendor=cursor')), 'DELIVERY_STUCK')
  assert.equal(deliveryFailureCode(Object.assign(new Error('possibly STEER_NOT_QUEUED'), { code: 'PEERTABLE_AITERM_FAILED' })), 'PEERTABLE_AITERM_FAILED')
})
