import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ParentSpool } from './parent-delivery.mjs'
import { atomicJson, processIdentity } from './parent-platform.mjs'

const waitFor = async condition => {
  const deadline = Date.now() + 30000
  while (!condition()) { if (Date.now() >= deadline) throw new Error('観測期限を超過しました'); await delay(20) }
}
test('probe実期限はSSEの心拍・新投稿を待たず、atomic再武装と成功にも追従する', async t => {
  const project = mkdtempSync(join(tmpdir(), 'peertable-probe-timer-'))
  let spool, watcher, stream
  const health = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); stream = res; return }
    if (req.url.endsWith('/members')) return json({ members: [{ name: 'parent', delivery: { kind: 'parent_receiver', endpoint_id: spool.id } }] })
    if (req.url.includes('/messages')) return json({ messages: [] })
    if (req.url.endsWith('/bridges')) { health.push(JSON.parse(raw)); return json({ ok: true }) }
    res.statusCode = 404; json({ error: 'fixture_path_unknown' })
  })
  t.after(async () => {
    if (watcher?.exitCode === null) { watcher.kill(); await once(watcher, 'exit') }
    stream?.destroy(); await new Promise(resolve => server.close(resolve))
    rmSync(project, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`, credential = join(project, 'credential')
  writeFileSync(credential, 'fixture', { mode: 0o600 })
  spool = ParentSpool.create(project, { name: 'parent', room: 'fixture', server_url: base, credential, start_seq: 0, harness: 'cursor', caller: { conversation: 'fixture', owner: processIdentity(process.pid) } })
  atomicJson(join(project, '.team', 'setup-state.json'), { room: 'fixture', server_url: base })
  watcher = spawn(process.execPath, [fileURLToPath(new URL('./parent-watch.mjs', import.meta.url)), project, 'parent', '--deliver', spool.id], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; watcher.stderr.on('data', chunk => { stderr += chunk })
  await waitFor(() => stream)
  // 成功したprobeのtimerが遅れて失敗を上書きしない。
  spool.update({ runtime: 'armed', probe_deadline: Date.now() + 200 })
  await delay(75); spool.update({ state: 'verified' }); await delay(250)
  assert.equal(spool.read().state, 'verified', stderr)
  assert.equal(spool.read().error_code, undefined)
  const deadline = Date.now() + 200
  spool.update({ state: 'receiving', runtime: 'armed', probe_deadline: deadline })
  await waitFor(() => spool.read().error_code === 'PARENT_PROBE_TIMEOUT' && health.some(item => item.state === 'failed' && JSON.parse(item.detail).error_code === 'PARENT_PROBE_TIMEOUT'))
  assert.ok(Date.now() < deadline + 1500, '心拍の25秒間隔に依存していません')
  assert.equal(spool.read().runtime, 'failed')
  assert.equal(spool.read().cursor, 0)
  assert.equal(watcher.exitCode, null, stderr)
})
test('SSEが正常で新seqが無くてもreceipt retry/孤児回収/probe期限/healthが進む', async t => {
  const project = mkdtempSync(join(tmpdir(), 'peertable-source-runtime-'))
  let spool, watcher, eventsConnected = false, receiptFailures = 0
  const receipts = [], health = [], streams = new Set()
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); streams.add(res); eventsConnected = true
      // 新しいroom messageは全試験中ゼロ。pingのheadもゼロのまま。
      const timer = setInterval(() => res.write('event: ping\ndata: 0\n\n'), 50)
      res.on('close', () => { clearInterval(timer); streams.delete(res) }); return
    }
    if (req.url.endsWith('/members')) return json({ members: [{ name: 'parent', delivery: { kind: 'parent_receiver', endpoint_id: spool.id } }] })
    if (req.url.includes('/messages')) return json({ messages: [] })
    if (req.url.endsWith('/summary')) return json({ seq: 0 })
    if (req.url.endsWith('/bridges')) { health.push(JSON.parse(raw)); return json({ ok: true }) }
    if (req.url.endsWith('/deliveries')) {
      if (receiptFailures > 0) { receiptFailures--; res.statusCode = 503; return json({ error: 'fixture_offline' }) }
      receipts.push(JSON.parse(raw)); return json({ ok: true })
    }
    res.statusCode = 404; json({ error: 'fixture_path_unknown' })
  })
  t.after(async () => {
    // 購読processを先に止める。SSEを先に閉じると再接続がserver.closeと競合する。
    if (watcher?.exitCode === null) { watcher.kill(); await once(watcher, 'exit') }
    for (const stream of streams) stream.destroy()
    await new Promise(resolve => server.close(resolve))
    rmSync(project, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`, credential = join(project, 'credential')
  writeFileSync(credential, 'fixture', { mode: 0o600 })
  spool = ParentSpool.create(project, { name: 'parent', room: 'fixture', server_url: base, credential, start_seq: 0, harness: 'cursor', caller: { conversation: 'fixture', owner: processIdentity(process.pid) } })
  atomicJson(join(project, '.team', 'setup-state.json'), { room: 'fixture', server_url: base })
  spool.update({ state: 'receiving', runtime: 'rearm_pending', created_at: '2000-01-01T00:00:00.000Z' })
  watcher = spawn(process.execPath, [fileURLToPath(new URL('./parent-watch.mjs', import.meta.url)), project, 'parent', '--deliver', spool.id], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; watcher.stderr.on('data', chunk => { stderr += chunk })
  await waitFor(() => eventsConnected && health.length > 0)
  assert.equal(spool.read().state, 'receiving')
  assert.equal(spool.read().error_code, undefined)
  assert.ok(health.some(item => item.state === 'rearm_pending'))
  spool.update({ state: 'verified', runtime: 'armed' })
  const sent = spool.saveEvent({ type: 'parent_dm', seq: 1, body: '出力済み本文' }), claimed = spool.claim('fixture', sent.delivery_id)
  spool.finish(claimed)
  receiptFailures = 1
  await spool.flushReceiptsAfterOutput()
  assert.equal(spool.read().records.find(record => record.delivery_id === sent.delivery_id).receipt.pending, true)
  assert.equal(spool.read().receipt_error.code, 'PEERTABLE_ROOM_REQUEST_FAILED')
  await waitFor(() => spool.read().records.find(record => record.delivery_id === sent.delivery_id).receipt.pending === false)
  assert.ok(receipts.some(receipt => receipt.seq === 1 && receipt.result === 'delivered'))
  assert.equal(spool.read().receipt_error, null)
  // 実childがclaimとwaiterを保存して終了。room新投稿なしでunknownとrearmへ回収する。
  const orphan = spool.saveEvent({ type: 'parent_dm', seq: 2, body: '保持する本文' })
  const code = `import {ParentSpool} from ${JSON.stringify(new URL('./parent-delivery.mjs', import.meta.url).href)};const s=new ParentSpool(process.argv[1],process.argv[2]);s.claim('fixture',process.argv[3]);s.slot('cursor_background');s.update({runtime:'armed'});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, project, spool.id, orphan.delivery_id], { stdio: 'ignore' })
  const [exit] = await once(child, 'exit'); assert.equal(exit, 0)
  await waitFor(() => receipts.some(receipt => receipt.seq === 2 && receipt.result === 'unknown') && health.some(item => item.state === 'rearm_pending'))
  assert.equal(spool.read().records.find(record => record.delivery_id === orphan.delivery_id).event.body, '保持する本文')
  const lastRevision = spool.read().records.find(record => record.delivery_id === orphan.delivery_id).receipt.receipt_revision
  await delay(150)
  assert.equal(spool.read().records.find(record => record.delivery_id === orphan.delivery_id).receipt.receipt_revision, lastRevision)
  spool.update({ state: 'receiving', probe_deadline: Date.now() + 100 })
  await waitFor(() => spool.read().error_code === 'PARENT_PROBE_TIMEOUT' && health.some(item => item.state === 'failed' && JSON.parse(item.detail).error_code === 'PARENT_PROBE_TIMEOUT'))
  assert.equal(spool.read().cursor, 0)
  assert.equal(watcher.exitCode, null, stderr)
})

test('親終了後のwatcherは所有索引を撤去し、project削除後も別の親の相関を壊さない', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'peertable-parent-index-'))
  const project = join(fixture, 'closed-project'), otherProject = join(fixture, 'other-project'), home = join(fixture, 'home')
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(owner, 'spawn')
  const identity = processIdentity(owner.pid)
  assert.ok(identity)
  const credential = join(fixture, 'credential'); writeFileSync(credential, 'fixture', { mode: 0o600 })
  let spool, watcher
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/members')) return res.end(JSON.stringify({ members: [{ name: 'parent', delivery: { kind: 'parent_receiver', endpoint_id: spool.id } }] }))
    if (req.url.endsWith('/bridges') || req.url.endsWith('/deliveries')) return res.end(JSON.stringify({ ok: true }))
    res.statusCode = 404; res.end(JSON.stringify({ error: 'fixture_path_unknown' }))
  })
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill(); await once(owner, 'exit') }
    if (watcher?.exitCode === null && watcher.signalCode === null) { watcher.kill(); await once(watcher, 'exit') }
    await new Promise(resolve => server.close(resolve))
    rmSync(fixture, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  spool = ParentSpool.create(project, { name: 'parent', room: 'fixture', server_url: base, credential, start_seq: 0, harness: 'codex', caller: { harness: 'codex', conversation: 'closed', owner: identity } })
  const other = ParentSpool.create(otherProject, { name: 'other', room: 'other', server_url: base, credential, start_seq: 0, harness: 'claude', caller: { harness: 'claude', conversation: 'other', owner: processIdentity(process.pid) } })
  const indexDir = join(home, '.peertable', 'parent-receivers', 'endpoints'), index = join(indexDir, `${spool.id}.json`), otherIndex = join(indexDir, `${other.id}.json`)
  atomicJson(index, { endpoint_id: spool.id, project }); atomicJson(otherIndex, { endpoint_id: other.id, project: otherProject })
  atomicJson(join(project, '.team', 'setup-state.json'), { room: 'fixture', server_url: base })
  const unread = spool.saveEvent({ type: 'parent_dm', seq: 1, body: '終了後にも保持する本文' })
  const submitted = spool.claim('fixture', unread.delivery_id); spool.finish(submitted)
  const pending = spool.saveEvent({ type: 'parent_dm', seq: 2, body: '未配送の本文' })
  owner.kill(); await once(owner, 'exit')
  watcher = spawn(process.execPath, [fileURLToPath(new URL('./parent-watch.mjs', import.meta.url)), project, 'parent', '--deliver', spool.id], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; watcher.stderr.on('data', chunk => { stderr += chunk })
  const [exit] = await once(watcher, 'exit'); assert.equal(exit, 0, stderr)
  const stopped = spool.read()
  assert.equal(stopped.runtime, 'stopped')
  assert.equal(stopped.error_code, 'PARENT_SESSION_CLOSED')
  assert.equal(stopped.watcher, null)
  assert.equal(stopped.records.find(record => record.delivery_id === unread.delivery_id).state, 'submitted')
  assert.equal(stopped.records.find(record => record.delivery_id === pending.delivery_id).state, 'failed')
  assert.deepEqual(stopped.records.map(record => record.event.body), ['終了後にも保持する本文', '未配送の本文'])
  assert.equal(existsSync(index), false)
  assert.equal(existsSync(otherIndex), true)
  rmSync(project, { recursive: true })
  const code = `import {endpointsFor} from ${JSON.stringify(new URL('./parent-caller.mjs', import.meta.url).href)};process.stdout.write(JSON.stringify(endpointsFor({caller:{harness:'claude',conversation:'other'}}).map(spool=>spool.id)));`
  const probe = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', probeError = ''; probe.stdout.on('data', chunk => { stdout += chunk }); probe.stderr.on('data', chunk => { probeError += chunk })
  const [probeExit] = await once(probe, 'exit'); assert.equal(probeExit, 0, probeError)
  assert.deepEqual(JSON.parse(stdout), [other.id])
})
