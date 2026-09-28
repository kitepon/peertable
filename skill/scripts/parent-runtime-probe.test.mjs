import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicJson, processIdentity } from './parent-platform.mjs'
import { joinEndpoint, stopEndpoint, projectEndpoints } from './parent-runtime.mjs'

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
    }
    await stopEndpoint(spool)
  }
})
