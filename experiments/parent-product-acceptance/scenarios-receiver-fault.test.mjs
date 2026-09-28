// caller/RPC期限の境界だけをfocusedで確認する。fixture成績を実親の合格へ数えない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { receiverMcpRows, receiverPreparationOwner, receiverPreparationFailure, codexReceiverFailureBoundary, installReceiverPreparationFault, observeReceiverStdin } from './scenarios-receiver-fault.mjs'

const at = n => new Date(n).toISOString()
const raw = (kind, row, time = 0, pid = 20, child_pid) => ({ kind, pid, child_pid, at: at(time), raw_base64: Buffer.from(JSON.stringify(row) + '\n').toString('base64') })
const args = { project: '/own', name: '親' }
const initialize = { id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } }
const request = { id: 2, method: 'tools/call', params: { name: 'parent_join', arguments: args, _meta: { threadId: 'CID' } } }
const parent = { pid: 10, started: 'parent-start', executable: process.execPath }, mcp = { pid: 20, started: 'mcp-start' }, owner = { pid: 21, started: 'child-start' }
const events = () => [raw('mcp_input_raw', initialize), raw('mcp_input_raw', request)]
const alive = identity => identity?.pid === parent.pid || identity?.pid === mcp.pid

test('受動MCP原bytesは改行/UTF-8 chunkを復元し、他方向/他processを合算しない', () => {
  const bytes = Buffer.from(JSON.stringify(request) + '\n'), split = bytes.indexOf(Buffer.from('親')) + 1
  const input = [bytes.subarray(0, split), bytes.subarray(split)].map(part => ({ pid: 20, kind: 'mcp_input_raw', raw_base64: part.toString('base64') }))
  assert.deepEqual(receiverMcpRows(input, 'mcp_input_raw')[0].row, request)
  assert.equal(receiverMcpRows(input, 'mcp_output_raw').length, 0)
  input[1].pid = 30
  assert.throws(() => receiverMcpRows(input, 'mcp_input_raw'), { code: 'ACCEPTANCE_QUEUE_FAULT_RPC_UTF8_INVALID' })
})

test('stdin受動観測はSDK開始までflowingにせず、既存data/戻り値を保持する', async () => {
  const stream = new PassThrough(), observed = [], consumed = []
  observeReceiverStdin(stream, chunk => observed.push(chunk))
  assert.equal(stream.readableFlowing, null)
  stream.write(Buffer.from('原<&>\r\n'))
  assert.equal(observed.length, 0)
  const received = new Promise(resolve => stream.once('data', resolve))
  stream.on('data', chunk => consumed.push(chunk))
  await received
  assert.equal(observed.length, 1); assert.ok(observed[0].equals(consumed[0])); assert.equal(consumed[0].toString(), '原<&>\r\n')
  assert.equal(stream.emit('unhandled-event'), false)
  stream.destroy()
})

test('initial receiverの所有は公式client/meta入力と実親/MCP/binary/endpoint未作成へ限定する', () => {
  const value = { events: events(), parent, mcp, executable: process.execPath, project: args.project, name: args.name, endpoints: [], sameProcess: alive, processDescendsFrom: (a, b) => a.pid === mcp.pid && b.pid === parent.pid }
  assert.equal(receiverPreparationOwner(value).session, 'CID')
  assert.throws(() => receiverPreparationOwner({ ...value, endpoints: ['existing'] }), { code: 'ACCEPTANCE_RECEIVER_PREPARATION_OWNER' })
  assert.throws(() => receiverPreparationOwner({ ...value, processDescendsFrom: () => false }), { code: 'ACCEPTANCE_RECEIVER_PREPARATION_OWNER' })
  assert.throws(() => receiverPreparationOwner({ ...value, events: [...events(), raw('mcp_input_raw', request)] }), { code: 'ACCEPTANCE_RECEIVER_MCP_CALLER_UNBOUND' })
  for (const mutate of [r => { r.params._meta = {} }, r => { r.params.arguments.name = '他親' }, r => { r.params._meta.threadId = {} }]) {
    const changed = structuredClone(request); mutate(changed)
    assert.throws(() => receiverPreparationOwner({ ...value, events: [raw('mcp_input_raw', initialize), raw('mcp_input_raw', changed)] }), { code: 'ACCEPTANCE_RECEIVER_MCP_CALLER_UNBOUND' })
  }
})

test('receiver期限failureは15秒原RPCと公式MCP出力/同CID item/自然消失/endpoint無しを要求する', () => {
  const error = { schema: 'peertable.parent-error.v1', state: 'failed', error_code: 'PARENT_CODEX_RPC_TIMEOUT', detail: 'initialize' }
  const pause = { parent, mcp, owner, session: 'CID', request: { row: request } }, native = { session: 'CID', arguments: args, result: error, turn_id: 'turn' }
  const timeline = [raw('rpc_write_raw', { id: 1, method: 'initialize' }, 100, 20, 21), raw('mcp_output_raw', { id: 2, result: { structuredContent: error, isError: true } }, 17100), { kind: 'receiver_child_closed', pid: 20, owner, identity_alive: false }]
  const value = { events: timeline, pause, native, endpoints: [], health: { members: [] }, sameProcess: alive }
  assert.equal(receiverPreparationFailure(value).rpc_failure_elapsed_ms, 17000)
  const reject = (mutate, code) => { const changed = structuredClone({ ...value, sameProcess: undefined }); changed.sameProcess = alive; mutate(changed); assert.throws(() => receiverPreparationFailure(changed), { code }) }
  reject(v => { v.native.session = '他CID' }, 'ACCEPTANCE_RECEIVER_RPC_FAILURE_MISSING')
  reject(v => { v.events[1].at = at(15099) }, 'ACCEPTANCE_RECEIVER_PREJOIN_FAILURE_BOUNDARY')
  reject(v => { v.endpoints = ['new-endpoint'] }, 'ACCEPTANCE_RECEIVER_PREJOIN_FAILURE_BOUNDARY')
  reject(v => { v.health = {} }, 'ACCEPTANCE_RECEIVER_PREJOIN_FAILURE_BOUNDARY')
  reject(v => { v.events[2].owner = { ...v.events[2].owner, started: '再利用PID' } }, 'ACCEPTANCE_RECEIVER_PREJOIN_FAILURE_BOUNDARY')
  reject(v => { v.events.push(raw('rpc_read_raw', { id: 1, result: {} }, 200, 20, 21)) }, 'ACCEPTANCE_RECEIVER_TIMEOUT_STAGE')
  const renamed = structuredClone(error); renamed.error_code = 'PARENT_BIND_TIMEOUT'
  assert.throws(() => receiverPreparationFailure({ ...value, native: { ...native, result: renamed } }), { code: 'ACCEPTANCE_RECEIVER_RPC_FAILURE_MISSING' })
})

test('公式completed MCP failureは原transcriptの同CID/全入力を要求し自由文で代用しない', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-receiver-native-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'rollout.jsonl'), error = { schema: 'peertable.parent-error.v1', state: 'failed', error_code: 'PARENT_CODEX_RPC_TIMEOUT', detail: 'initialize' }
  const rows = [{ type: 'session_meta', payload: { id: 'CID' } }, { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'CID', turn_id: 'turn', item: { type: 'McpToolCall', id: 'native-id', server: 'peertable_parent', tool: 'parent_join', status: 'completed', arguments: args, result: { structuredContent: error } } } }]
  const save = () => writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n')
  save(); assert.equal(codexReceiverFailureBoundary({ file, session: 'CID', arguments: args }).id, 'native-id')
  rows[1].payload.item.status = 'failed'; save(); assert.equal(codexReceiverFailureBoundary({ file, session: 'CID', arguments: args }).result.error_code, 'PARENT_CODEX_RPC_TIMEOUT')
  rows[1].payload.item.status = 'inProgress'; save(); assert.equal(codexReceiverFailureBoundary({ file, session: 'CID', arguments: args }), null)
  rows[1].payload.item.status = 'completed'; save()
  assert.equal(codexReceiverFailureBoundary({ file, session: 'CID', arguments: { ...args, name: '他親' } }), null)
  rows[0].payload.id = '別CID'; save(); assert.equal(codexReceiverFailureBoundary({ file, session: 'CID', arguments: args }), null)
})

test('receiver OS observerは専用親起動前だけ、Windows未実測はtyped未達にする', async () => {
  await assert.rejects(installReceiverPreparationFault({ harness: 'codex', pty: 'live' }, {}), { code: 'ACCEPTANCE_RECEIVER_FAULT_PREPARATION_ORDER' })
  if (process.platform === 'win32') await assert.rejects(installReceiverPreparationFault({ harness: 'codex' }, {}), { code: 'ACCEPTANCE_RECEIVER_FAULT_OS_API_UNCONFIRMED' })
})
