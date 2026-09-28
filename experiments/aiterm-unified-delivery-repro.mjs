#!/usr/bin/env node
// 公開MCP境界とroom境界だけで、統合配送・保留・通知の耐再起動を再現する。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AitermClient } from '../skill/scripts/aiterm-client.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = join(repo, 'experiments/fixtures/aiterm-unified-mcp.mjs')
const root = await mkdtemp(join(tmpdir(), 'peertable-unified-'))
const project = join(root, 'project')
const bin = join(root, 'bin')
const specPath = join(root, 'spec.json')
const callsPath = join(root, 'calls.jsonl')
const statePath = join(project, '.team/wakeup-bridge-delivery.json')
const seats = ['claude', 'codex', 'grok', 'cursor']
const actualParent = { name: 'parent', harness: 'codex', delivery: { kind: 'parent_receiver', harness: 'codex', endpoint_id: randomUUID() } }
const members = [...seats.map(name => ({ name, harness: name, aiterm_session_id: `session-${name}`, read_seq: 0 })), actualParent]
const messages = []
const receipts = new Map()
const notifications = []
const noticeAttempts = []
const streams = new Set()
let failNoticeOnce = true
let child
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, label, timeout = 12_000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await predicate()) return
    await sleep(60)
  }
  throw new Error(`${label}: timeout`)
}
const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const setSpec = async data => writeFile(specPath, JSON.stringify(data))
const emit = msg => { for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`) }
const post = (to, body) => { const msg = { seq: messages.length + 1, from: 'sender', to, body }; messages.push(msg); emit(msg); return msg.seq }
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1')
  const send = (code, body) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  if (request.method === 'GET' && path.pathname.endsWith('/events')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': connected\n\n')
    streams.add(response)
    request.on('close', () => streams.delete(response))
  } else if (request.method === 'GET' && path.pathname.endsWith('/members')) send(200, { members })
  else if (request.method === 'GET' && path.pathname.endsWith('/messages')) send(200, { messages: messages.filter(msg => msg.seq > Number(path.searchParams.get('since') ?? 0)) })
  else if (request.method === 'POST' && path.pathname.endsWith('/bridges')) send(200, {})
  else if (request.method === 'POST' && path.pathname.endsWith('/deliveries')) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const data = JSON.parse(Buffer.concat(chunks).toString())
    receipts.set(`${data.seq}:${data.recipient}`, data)
    send(200, {})
  } else if (request.method === 'POST' && path.pathname.endsWith('/messages')) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const data = JSON.parse(Buffer.concat(chunks).toString())
    if (data.from === 'wakeup') noticeAttempts.push(data)
    if (data.from === 'wakeup' && failNoticeOnce) { failNoticeOnce = false; send(500, {}); return }
    notifications.push(data)
    send(200, { seq: 999 })
  } else send(404, {})
})
const stop = async () => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
const bridgeLog = []
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
fixtureEnv.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
Object.assign(fixtureEnv, {
  PEERTABLE_TEST_AITERM_SPEC: specPath,
  PEERTABLE_TEST_AITERM_CALLS: callsPath,
  PEERTABLE_TEST_DELIVERY_STATE: statePath,
  // 旧envを無関係な名前にし、room台帳の親だけを通知先へ選ぶことを検証する。
  PEERTABLE_PARENT_NAME: 'env-not-the-room-parent',
})
const start = () => {
  child = spawn(process.execPath, [join(repo, 'skill/scripts/wakeup-bridge.mjs'), project], {
    env: fixtureEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', data => bridgeLog.push(data.toString()))
  child.stderr.on('data', data => bridgeLog.push(data.toString()))
}
try {
  await mkdir(join(project, '.team'), { recursive: true })
  await mkdir(bin)
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'aiterm-mcp.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
  } else {
    await symlink(fixture, join(bin, 'aiterm-mcp'))
  }
  await writeFile(callsPath, '')
  await setSpec({ state: 'busy' })
  const probe = new AitermClient({ env: fixtureEnv })
  try {
    const observed = await probe.observe(`fixture-probe-${process.pid}-${Date.now()}`)
    assert.equal(observed.exists, true, '公開MCPが試験fixtureへ接続する')
    assert.equal(observed.state, 'busy')
  } finally { await probe.close() }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({ room: 'fixture', server_url: `http://127.0.0.1:${server.address().port}` }))
  start()
  await waitFor(async () => {
    try { return Boolean(JSON.parse(await readFile(join(project, '.team/wakeup-bridge.json'))).ready_at) } catch { return false }
  }, 'bridge ready')
  for (const seat of seats) post(seat, `busy-${seat}`)
  await waitFor(() => receipts.size === 4, 'busy receipts')
  assert.deepEqual((await calls()).map(call => call.session_id).sort(), seats.map(seat => `session-${seat}`).sort())
  assert.ok([...receipts.values()].every(item => item.result === 'delivered'))
  await setSpec({ state: 'idle' })
  const idleSeq = post('grok', 'idle-grok')
  await waitFor(() => receipts.get(`${idleSeq}:grok`)?.result === 'delivered', 'idle receipt')
  assert.equal((await calls()).length, 5)

  await setSpec({ state: 'busy', error: 'STEER_NOT_QUEUED' })
  const heldSeq = post('cursor', 'unknown-cursor')
  await waitFor(() => receipts.get(`${heldSeq}:cursor`)?.result === 'failed', 'held receipt')
  assert.equal(receipts.get(`${heldSeq}:cursor`).reason, 'STEER_NOT_QUEUED')
  assert.equal(failNoticeOnce, false, '親への初回POSTが失敗した')
  assert.equal(noticeAttempts[0].to, actualParent.name, '初回POSTは旧envでなく台帳の親を宛先にする')
  const before = (await calls()).length
  assert.equal(before, 6)
  await stop()
  await setSpec({ state: 'idle' })
  start()
  await waitFor(() => notifications.some(item => item.body.includes(`seq=${heldSeq}`)), '再起動後の親通知再試行')
  assert.ok(notifications.some(item => item.body.includes(`seq=${heldSeq}`) && item.body.includes('理由=STEER_NOT_QUEUED') && item.to === actualParent.name), '再起動後の再試行も台帳の親へ通知する')
  assert.ok(noticeAttempts.every(item => item.to === actualParent.name), '失敗したPOSTも含め通知先は台帳の親だけ')
  const state = JSON.parse(await readFile(join(project, '.team/wakeup-bridge-delivery.json')))
  assert.equal(state.held[`${heldSeq}:cursor`], 'STEER_NOT_QUEUED')
  assert.ok(state.notified.includes(`${heldSeq}:cursor`))
  assert.ok(!state.delivered.includes(`${heldSeq}:cursor`))
  await sleep(2300)
  assert.equal((await calls()).length, before, '保留本文を再送しない')
  assert.equal(notifications.filter(item => item.body.includes(`seq=${heldSeq}`)).length, 1, '親通知を重複しない')
  const nextSeq = post('cursor', 'later-cursor')
  await waitFor(() => receipts.get(`${nextSeq}:cursor`)?.result === 'delivered', 'later delivery')
  members.find(member => member.name === 'cursor').read_seq = heldSeq
  await waitFor(() => receipts.get(`${heldSeq}:cursor`)?.reason === 'acked_read', 'held ack')
  assert.equal((await calls()).filter(call => call.text.includes('unknown-cursor')).length, 1)

  await setSpec({ state: 'idle', breakStateOnSend: true })
  const storageSeq = post('grok', 'storage-failure')
  await waitFor(() => receipts.get(`${storageSeq}:grok`)?.result === 'failed', 'state save failure receipt')
  assert.ok(bridgeLog.join('').includes('DELIVERY_STATE_SAVE_FAILED'))
  await rm(statePath, { recursive: true })
  await rename(`${statePath}.saved`, statePath)
  await setSpec({ state: 'idle' })
  const storageCalls = (await calls()).filter(call => call.text.includes('storage-failure')).length
  await waitFor(async () => JSON.parse(await readFile(statePath)).held[`${storageSeq}:grok`] === 'DELIVERY_STATE_SAVE_FAILED', 'state retry')
  await sleep(2300)
  assert.equal((await calls()).filter(call => call.text.includes('storage-failure')).length, storageCalls, '保存失敗後に本文を再送しない')

  await setSpec({ state: 'unknown', reason: 'unrecognized_screen' })
  const unknownSeq = post('claude', 'unknown-screen-claude')
  await waitFor(() => receipts.get(`${unknownSeq}:claude`)?.result === 'delivered', 'unknown画面のClaude席へ配送')
  assert.equal((await calls()).filter(call => call.text.includes('unknown-screen-claude')).length, 1)
  console.log('統合配送・保留・通知再試行・再起動・既読ack・unknown画面のClaude配送: 成功')
} catch (error) {
  console.error(error.stack ?? error.message)
  console.error(bridgeLog.join('').slice(-4000))
  process.exitCode = 1
} finally {
  await stop()
  for (const stream of streams) stream.end()
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
