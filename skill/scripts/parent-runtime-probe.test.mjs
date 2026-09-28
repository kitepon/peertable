import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicJson, processIdentity } from './parent-platform.mjs'
import { joinEndpoint, stopEndpoint, projectEndpoints } from './parent-runtime.mjs'
import { failedParentRecords } from './parent-delivery.mjs'

test('初回Codex joinはwatcher起動前にprobe期限を開始し、背景登録待ちのCursorは開始しない', async t => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'peertable-join-probe-')))
  const credential = join(project, 'credential')
  writeFileSync(credential, 'fixture', { mode: 0o600 })
  const previousCredential = process.env.PEERTABLE_CREDENTIAL_FILE
  process.env.PEERTABLE_CREDENTIAL_FILE = credential
  const members = [], streams = new Set()
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    res.setHeader('content-type', 'application/json')
    const json = value => res.end(JSON.stringify(value))
    if (req.url.endsWith('/members')) {
      if (req.method === 'POST') members.push(JSON.parse(raw))
      return json({ members })
    }
    if (req.url.endsWith('/summary')) return json({ seq: 0 })
    if (req.url.includes('/messages')) return json({ messages: [] })
    if (req.url.endsWith('/bridges') || req.url.endsWith('/deliveries')) return json({ ok: true })
    if (req.url.endsWith('/events')) {
      res.setHeader('content-type', 'text/event-stream'); res.write('event: ping\ndata: 0\n\n')
      streams.add(res); res.on('close', () => streams.delete(res)); return
    }
    res.statusCode = 404; json({ error: 'fixture_path_unknown' })
  })
  t.after(async () => {
    for (const spool of projectEndpoints(project)) await stopEndpoint(spool)
    for (const stream of streams) stream.destroy()
    await new Promise(resolve => server.close(resolve))
    if (previousCredential === undefined) delete process.env.PEERTABLE_CREDENTIAL_FILE
    else process.env.PEERTABLE_CREDENTIAL_FILE = previousCredential
    rmSync(project, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  atomicJson(join(project, '.team/setup-state.json'), { room: 'fixture', server_url: `http://127.0.0.1:${server.address().port}` })
  // joinEndpointの内部契約を直接試す。公式harness/MCPの実機受入には算入しない。
  for (const harness of ['codex', 'cursor']) {
    const before = Date.now()
    const spool = await joinEndpoint(project, `fixture-${harness}`, { harness, conversation: `fixture-${harness}`, owner: processIdentity(process.pid) })
    const after = Date.now(), state = spool.read()
    assert.equal(state.state, 'receiving')
    if (harness === 'codex') {
      assert.equal(state.runtime, 'armed')
      assert.ok(state.probe_deadline >= before + 30000 && state.probe_deadline <= after + 30000)
    } else {
      assert.equal(state.runtime, 'rearm_pending')
      assert.equal(state.probe_deadline, undefined)
      // 生存中watcherの明示rejoinでも、新probeだけを追加し、失敗本文とcursorを保つ。
      const failedProbe = state.records.find(record => record.event.type === 'parent_probe')
      const failedDm = spool.saveEvent({ type: 'parent_dm', seq: 1, body: '配送失敗を保持する本文' })
      const unknownDm = spool.saveEvent({ type: 'parent_dm', seq: 2, body: '未確定を保持する本文' })
      spool.transact(saved => {
        saved.state = 'failed'; saved.runtime = 'failed'; saved.error_code = 'PARENT_PROBE_TIMEOUT'
        for (const record of saved.records) record.state = record.delivery_id === unknownDm.delivery_id ? 'unknown' : 'failed'
      })
      const rejoined = await joinEndpoint(project, `fixture-${harness}`, { harness, conversation: `fixture-${harness}`, owner: processIdentity(process.pid) })
      const renewed = rejoined.read()
      assert.equal(rejoined.id, spool.id)
      assert.deepEqual(renewed.watcher, state.watcher)
      assert.notEqual(renewed.probe_id, state.probe_id)
      assert.equal(renewed.cursor, state.cursor)
      assert.deepEqual(renewed.records.find(record => record.delivery_id === failedProbe.delivery_id).event, failedProbe.event)
      assert.equal(renewed.records.find(record => record.delivery_id === failedDm.delivery_id).state, 'failed')
      assert.equal(renewed.records.find(record => record.delivery_id === unknownDm.delivery_id).state, 'unknown')
      const retry = spool.claim('parent_read')
      assert.equal(retry.event.event_id, `probe:${renewed.probe_id}`)
      assert.ok(failedParentRecords(spool.read()).some(record => record.delivery_id === failedProbe.delivery_id))
      spool.finish(retry)
      const verified = spool.read()
      assert.equal(verified.state, 'verified')
      assert.equal(verified.records.find(record => record.delivery_id === failedProbe.delivery_id).state, 'failed')
      assert.equal(verified.records.find(record => record.delivery_id === failedProbe.delivery_id).resolved_by, retry.delivery_id)
      assert.deepEqual(failedParentRecords(verified).map(record => record.delivery_id), [failedDm.delivery_id])
      await joinEndpoint(project, `fixture-${harness}`, { harness, conversation: `fixture-${harness}`, owner: processIdentity(process.pid) })
      assert.equal(spool.read().probe_id, renewed.probe_id)
      assert.equal(spool.read().records.length, verified.records.length)
      spool.transact(saved => {
        saved.state = 'failed'; saved.runtime = 'failed'
        saved.records.find(record => record.delivery_id === retry.delivery_id).state = 'unknown'
      })
      await joinEndpoint(project, `fixture-${harness}`, { harness, conversation: `fixture-${harness}`, owner: processIdentity(process.pid) })
      assert.equal(spool.read().probe_id, renewed.probe_id)
      assert.equal(spool.read().records.length, verified.records.length)
      assert.equal(spool.read().records.find(record => record.delivery_id === retry.delivery_id).state, 'unknown')
    }
    await stopEndpoint(spool)
  }
})
