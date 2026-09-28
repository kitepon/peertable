// RPC/期限observerのfocused。代替fixtureを実親の合格へ数えない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queueFaultRpcRows, queueProbeReceiverProof, queueProbeTimeoutProof, watchQueueProbeState, installQueueProbeFault, codexProbeJoinBoundary, observedQueueConnections } from './scenarios-queue-fault.mjs'
import { codexFixtureEnvironmentArgs } from './scenarios-fixtures.mjs'

const at = ms => new Date(ms).toISOString()
const pause = { endpoint_id: 'own', project: '/own project', caller: { conversation: 'CID' }, executable: '/codex', watcher: { pid: 20 }, owner: { pid: 21 }, paused_at: at(200), spool_before: { probe_deadline: 1000 } }
const connection = { kind: 'official_connection_spawn', at: at(100), pid: 10, child_pid: 11, executable: '/codex', spawn_argv: ['app-server', '--listen', 'stdio://'] }
const rpc = (kind, row, pid = 10, child_pid = 11) => ({ kind, pid, child_pid, at: at(150), raw: JSON.stringify(row) + '\n' })
const owned = eventName => ({ eventName, command: '/node /pkg/hook codex', sourcePath: '/normal/hooks.json', handlerType: 'command', async: false, enabled: true, trustStatus: 'trusted' })
const receiverEvents = () => [connection, ...[
  ['initialize', {}, {}],
  ['thread/read', { threadId: 'CID', includeTurns: false }, { thread: { id: 'CID' } }],
  ['thread/queue/list', { threadId: 'CID', limit: 1 }, { data: [] }],
  ['hooks/list', { cwds: ['/own project'] }, { data: [{ hooks: [owned('postToolUse'), owned('stop')] }] }],
].flatMap(([method, params, result], i) => [rpc('rpc_write_raw', { id: i + 1, method, params }), rpc('rpc_read_raw', { id: i + 1, result })]), rpc('rpc_write_raw', { id: 1, method: 'initialize' }, 20, 21)]
const prove = events => queueProbeReceiverProof({ events, pause, expectedCommand: '/node /pkg/hook codex', expectedSource: '/normal/hooks.json' })

test('公式RPCは方向/接続ごとにchunkを連結し、未確定末尾は判定しない', () => {
  const events = [rpc('rpc_read_raw', { id: 1, result: {} })]
  const raw = events[0].raw
  assert.deepEqual(queueFaultRpcRows([{ ...events[0], raw: raw.slice(0, 7) }, { ...events[0], raw: raw.slice(7) }])[0].row, { id: 1, result: {} })
  assert.equal(queueFaultRpcRows([{ ...events[0], raw: raw.slice(0, -1) }]).length, 0)
  assert.throws(() => queueFaultRpcRows([{ ...events[0], raw: '非JSON\n' }]), { code: 'ACCEPTANCE_QUEUE_FAULT_RPC_CORRUPT' })
  const bytes = Buffer.from(JSON.stringify({ id: 2, result: { text: '原文<&>\r\n' } }) + '\n'), boundary = bytes.indexOf(Buffer.from('原')) + 1
  const byteEvents = [bytes.subarray(0, boundary), bytes.subarray(boundary)].map(chunk => ({ ...events[0], raw: chunk.toString('utf8'), raw_base64: chunk.toString('base64') }))
  assert.equal(queueFaultRpcRows(byteEvents)[0].row.result.text, '原文<&>\r\n')
  assert.throws(() => queueFaultRpcRows([{ ...events[0], raw_base64: Buffer.from([0xff]).toString('base64') }]), { code: 'ACCEPTANCE_QUEUE_FAULT_RPC_UTF8_INVALID' })
})

test('receiver成功と初回queue受付前を照合し、別CID/不信頼/受付後を拒否する', () => {
  assert.equal(prove(receiverEvents()).stopped_before_queue_add, true)
  const other = receiverEvents(); other[3] = rpc('rpc_write_raw', { id: 2, method: 'thread/read', params: { threadId: 'foreign', includeTurns: false } })
  assert.throws(() => prove(other), { code: 'ACCEPTANCE_QUEUE_RECEIVER_CHECK_MISSING' })
  const untrusted = receiverEvents(); untrusted[8] = rpc('rpc_read_raw', { id: 4, result: { data: [{ hooks: [{ ...owned('postToolUse'), trustStatus: 'unknown' }, owned('stop')] }] } })
  assert.throws(() => prove(untrusted), { code: 'ACCEPTANCE_QUEUE_RECEIVER_CHECK_MISSING' })
  assert.throws(() => prove([...receiverEvents(), rpc('rpc_write_raw', { id: 2, method: 'thread/queue/add' }, 20, 21)]), { code: 'ACCEPTANCE_QUEUE_PROBE_FAULT_STAGE' })
})

test('Codex MCP境界は同CID/turnの公式completed itemだけを読む', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-probe-join-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'rollout.jsonl'), query = { file, session: 'CID', project: '/own project', name: 'own', endpointId: 'endpoint' }
  const rows = [{ type: 'session_meta', payload: { id: 'CID' } }, { timestamp: at(10), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'CID', turn_id: 'turn', item: { type: 'McpToolCall', id: 'tool-use-id', server: 'peertable_parent', tool: 'parent_join', status: 'completed', arguments: { project: '/own project', name: 'own' }, result: { structuredContent: { schema: 'peertable.parent-join-result.v1', endpoint_id: 'endpoint', state: 'receiving' } } } } }]
  const save = () => writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n')
  save(); assert.equal(codexProbeJoinBoundary(query).native_tool_use_id, 'tool-use-id')
  assert.equal(codexProbeJoinBoundary({ ...query, after: 1 }), null)
  rows[1].payload.item.arguments.project = '/foreign'; save(); assert.equal(codexProbeJoinBoundary(query), null)
  rows[1].payload.item.arguments.project = '/own project'; rows[0].payload.id = 'another CID'; save(); assert.equal(codexProbeJoinBoundary(query), null)
  rows[0].payload.id = 'CID'; rows[1].payload.item.status = 'inProgress'; save(); assert.equal(codexProbeJoinBoundary(query), null)
})

test('期限failureは実spool/health両方と共通観測上限を要求する', () => {
  const state = { endpoint_id: 'own', state: 'failed', runtime: 'failed', error_code: 'PARENT_PROBE_TIMEOUT' }
  const observations = [{ at: at(1010), state }]
  const health = { bridges: { parent_receiver: { endpoints: [{ endpoint_id: 'own', state: 'failed', beat_at: at(1005), detail: JSON.stringify(state) }] } } }
  assert.equal(queueProbeTimeoutProof({ pause, observations, health }).failed_observation_lag_ms, 10)
  assert.equal(queueProbeTimeoutProof({ pause, observations, health }).max_observation_lag_ms, 1500)
  assert.throws(() => queueProbeTimeoutProof({ pause, observations: [{ at: at(15478), state }], health }), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_LATE' })
  assert.throws(() => queueProbeTimeoutProof({ pause, observations: [{ at: at(2501), state }], health }), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_LATE' })
  assert.throws(() => queueProbeTimeoutProof({ pause, observations: [{ at: at(999), state }], health }), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_EARLY' })
  const earlyHealth = structuredClone(health); earlyHealth.bridges.parent_receiver.endpoints[0].beat_at = at(999)
  assert.throws(() => queueProbeTimeoutProof({ pause, observations, health: earlyHealth }), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_EARLY' })
  assert.throws(() => queueProbeTimeoutProof({ pause, observations, health: {} }), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_NOT_OBSERVED' })
})

test('spool observerは実atomic renameを追い、本文と時刻を原保存する', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-probe-watch-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'spool.json'), artifact = join(dir, 'observer.jsonl')
  writeFileSync(file, JSON.stringify({ state: 'receiving', probe_deadline: Date.now() + 100 }))
  const observer = watchQueueProbeState({ spool: { file }, artifact }); t.after(() => observer.close())
  const text = JSON.stringify({ state: 'failed', error_code: 'PARENT_PROBE_TIMEOUT', original: '原文<&\r\n' })
  writeFileSync(join(dir, 'tmp'), text); renameSync(join(dir, 'tmp'), file)
  const end = Date.now() + 2000
  while (!observer.rows.some(row => row.state.state === 'failed')) { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 10)) }
  observer.close(); assert.equal(observer.error, null)
  const saved = readFileSync(artifact, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(saved.find(row => row.state.state === 'failed').raw, text)
})

test('専用OS observerは起動前だけ、既存MCP環境参照を保持する', async () => {
  const argv = codexFixtureEnvironmentArgs(['EXISTING', 'PEERTABLE_TOKEN_SOURCE_FILE'], { NODE_OPTIONS: '--import=own', PEERTABLE_ACCEPTANCE_QUEUE_PROBE: '/own/config' })
  assert.equal(argv[1], 'mcp_servers.peertable_parent.env_vars=["EXISTING","PEERTABLE_TOKEN_SOURCE_FILE","NODE_OPTIONS","PEERTABLE_ACCEPTANCE_QUEUE_PROBE"]')
  assert.throws(() => codexFixtureEnvironmentArgs('不明形式'), { code: 'ACCEPTANCE_CODEX_ENV_VARS_SCHEMA' })
  await assert.rejects(installQueueProbeFault({ harness: 'codex', pty: 'already' }, {}), { code: 'ACCEPTANCE_QUEUE_FAULT_PREPARATION_ORDER' })
})

test('短命queue接続はspawn時本人/claim/RPC応答/closeを直接相関する', () => {
  const owner = { pid: 21, started: 'child-start' }, watcher = { pid: 20, started: 'watcher-start' }
  const start = { ...connection, pid: watcher.pid, child_pid: owner.pid, child_owner: owner, queue_owner: watcher, owned_queue: true, endpoint_id: 'own', session: 'CID', queue_record: { delivery_id: 'delivery' } }
  const events = [start, rpc('rpc_write_raw', { id: 2, method: 'thread/queue/add', params: { threadId: 'CID', clientUserMessageId: 'delivery' } }, watcher.pid, owner.pid), rpc('rpc_read_raw', { id: 2, result: { queuedSubmission: { id: 'queue-accepted' } } }, watcher.pid, owner.pid), { kind: 'official_connection_closed', at: at(151), pid: watcher.pid, child_pid: owner.pid, child_owner: owner, child_identity_alive: false }]
  const query = { events, watcher, endpointId: 'own', session: 'CID' }
  const found = observedQueueConnections(query)
  assert.equal(found.length, 1); assert.equal(found[0].closed_at, at(151)); assert.equal(found[0].accepted[0].queued_submission_id, 'queue-accepted')
  assert.equal(observedQueueConnections({ ...query, session: 'foreign' }).length, 0)
  assert.equal(observedQueueConnections({ ...query, watcher: { ...watcher, started: 'reused' } }).length, 0)
  events[3].child_owner = { ...owner, started: 'reused' }; assert.equal(observedQueueConnections(query)[0].closed_at, null)
})
