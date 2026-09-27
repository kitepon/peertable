import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('実room clientが公開session IDと席資格で参加・投稿し、serverが公開観測先への配達経路を認識する', { timeout: 20_000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'peertable-room-public-'))
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const credential = join(dir, 'fixture.token')
  writeFileSync(credential, 'fixture-token\n', { mode: 0o600 })
  const server = spawn(process.execPath, [join(root, 'room/server.mjs')], {
    env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: dir, PEERTABLE_POST_TOKEN: 'fixture-token' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const mcp = new Client({ name: 'peertable-public-session-test', version: '1' })
  t.after(async () => {
    await mcp.close()
    if (server.exitCode === null) { server.kill(); await once(server, 'exit') }
    rmSync(dir, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) => {
    let output = ''
    server.stderr.on('data', chunk => {
      output += chunk
      if (output.includes(`server on :${port}`)) resolve()
    })
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`room起動失敗: ${code}: ${output}`)))
  })
  const placement = JSON.parse(execFileSync(process.execPath, [join(root, 'skill/scripts/resolve-seat-placement.mjs'), '--roles', '実装'], { encoding: 'utf8' }))
  const { harness, model, effort } = placement.settings
  const env = { ...process.env, PEERTABLE_URL: `http://127.0.0.1:${port}`, PEERTABLE_ROOM: 'fixture',
    PEERTABLE_MEMBER: 'alice', PEERTABLE_HARNESS: harness, PEERTABLE_VENDOR: harness, PEERTABLE_MODEL: model,
    PEERTABLE_EFFORT: effort, PEERTABLE_ROLE: '実装', PEERTABLE_ROLES: '実装', PEERTABLE_CREDENTIAL_FILE: credential,
    AITERM_SESSION_ID: '公開-session-日本語',
  }
  delete env.PEERTABLE_POST_TOKEN
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'room/client.mjs')], env, stderr: 'pipe' }))
  const api = async (path, options = {}) => {
    const response = await fetch(`${env.PEERTABLE_URL}/api/fixture/${path}`, {
      ...options, headers: { 'content-type': 'application/json', 'X-Peertable-Token': 'fixture-token' },
    })
    assert.equal(response.ok, true, `${path}: ${response.status}`)
    return response.json()
  }
  const deadline = Date.now() + 5_000
  let alice
  while (!alice && Date.now() < deadline) {
    alice = (await api('members')).members.find(member => member.name === 'alice')
    if (!alice) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(alice, 'room clientの会員登録が期限内に完了する')
  assert.equal(alice.aiterm_session_id, env.AITERM_SESSION_ID)
  assert.deepEqual(alice.observe, { aiterm_session_id: env.AITERM_SESSION_ID })
  assert.deepEqual(alice.roles, ['実装'])
  await api('members', { method: 'POST', body: JSON.stringify({ name: 'beta', observe: { aiterm_session_id: 'beta-public-session' } }) })
  const posted = await mcp.callTool({ name: 'post', arguments: { to: 'beta', message: '公開APIとroomの境界確認' } })
  assert.equal(posted.isError, undefined)
  assert.match(posted.content[0].text, /room_saved/)
  const { messages } = await api('messages')
  const message = messages.find(item => item.body === '公開APIとroomの境界確認')
  assert.ok(message)
  const { delivery } = await api(`deliveries?seq=${message.seq}`)
  assert.equal(delivery.beta.state, 'bridge_unavailable')
  assert.notEqual(delivery.beta.reason, 'no_delivery_route')
  assert.doesNotMatch(JSON.stringify({ alice, posted, message }), /fixture-token/)
})
