import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const waitFor = async (condition, label) => {
  const deadline = Date.now() + 30000
  while (!(await condition())) { if (Date.now() >= deadline) throw new Error(`${label}の観測期限を超過しました`); await delay(20) }
}

// 実SDKのstdioで親用MCPを起動し、roomの親宛発言が背景受信（Grok等と同じ経路）で届き、receiptが返るまでを通す。
test('parent_joinで受信を張り、roomの親宛発言だけを背景受信で順に受け取る', async t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable-parent-e2e-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home'), project = join(root, 'project')
  mkdirSync(home); mkdirSync(join(project, '.team'), { recursive: true })
  const members = new Map(), receipts = [], messages = [], streams = new Set()
  const api = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const url = new URL(req.url, 'http://x'), path = url.pathname.replace(/^\/api\/[^/]+/u, '')
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n'); streams.add(res)
      req.on('close', () => streams.delete(res)); return
    }
    res.setHeader('content-type', 'application/json')
    if (path === '/summary') return res.end(JSON.stringify({ seq: messages.length }))
    if (path === '/members' && req.method === 'POST') { const member = JSON.parse(raw); members.set(member.name, member); return res.end('{"ok":true}') }
    if (path.startsWith('/members/') && req.method === 'DELETE') { members.delete(decodeURIComponent(path.slice(9))); return res.end('{"ok":true}') }
    if (path === '/members') return res.end(JSON.stringify({ members: [...members.values()] }))
    if (path === '/messages') return res.end(JSON.stringify({ messages: messages.filter(message => message.seq > Number(url.searchParams.get('since') ?? 0)) }))
    if (path === '/deliveries') { receipts.push(JSON.parse(raw)); return res.end('{"ok":true}') }
    if (path === '/bridges') return res.end('{"ok":true}')
    res.statusCode = 404; res.end('{}')
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => { for (const stream of streams) stream.destroy(); return new Promise(resolve => api.close(resolve)) })
  const serverUrl = `http://127.0.0.1:${api.address().port}`
  writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: 'fixture', server_url: serverUrl }))
  const credential = join(root, 'token'); writeFileSync(credential, 'fixture', { mode: 0o600 })
  const post = (from, to, body) => {
    const message = { seq: messages.length + 1, from, to, ...(Array.isArray(to) ? { to: null, to_names: to } : {}), body, at: new Date().toISOString() }
    messages.push(message)
    for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, PEERTABLE_CREDENTIAL_FILE: credential }
  // 親processの特定は実harnessに依存するため、この試験では試験process自身を親として渡す。
  const code = String.raw`import {runParentClient} from ${JSON.stringify(new URL('./parent-client.mjs', import.meta.url).href)};import {processIdentity} from ${JSON.stringify(new URL('../skill/scripts/parent-platform.mjs', import.meta.url).href)};const owner=processIdentity(Number(process.argv[1]));await runParentClient({owner:()=>owner});`
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', code, String(process.pid)], env, stderr: 'pipe' })
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk })
  const client = new Client({ name: 'grok-shell-peertable_parent', version: 'fixture' })
  t.after(() => client.close())
  await client.connect(transport)
  const joined = await client.callTool({ name: 'parent_join', arguments: { project, name: 'bell' } })
  assert.equal(joined.isError, undefined, `${JSON.stringify(joined)}\n${stderr}`)
  const result = joined.structuredContent
  assert.equal(result.harness, 'grok')
  assert.equal(members.get('bell').delivery.endpoint_id, result.endpoint_id)
  const receive = wait => new Promise((resolve, reject) => {
    const child = spawn(wait.executable, wait.args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', data => { out += data }); child.stderr.on('data', data => { err += data })
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${out}${err}`)))
  })
  await waitFor(() => streams.size > 0, 'watcherのSSE接続')
  const first = receive(result.wait_process)
  post('mio', 'bell', '親宛のDM\n"引用"😀')
  post('mio', 'rui', '他の席宛は届かない')
  post('rui', 'all', '全体への発言')
  const got = await first
  assert.equal(got.outcome, 'delivered')
  const texts = got.deliveries.map(item => item.text)
  // 起動時の知らせ（parent_watch_snapshot）と親宛の2通。受信processが一度に取れなかった分は、張り直した受信で届く。
  const all = [...texts]
  let next = got.next_wait_process
  while (all.length < 3) { const more = await receive(next); all.push(...more.deliveries.map(item => item.text)); next = more.next_wait_process }
  assert.equal(all.length, 3)
  assert.match(all[0], /親番犬を張り直した/u)
  assert.match(all[1], /seq=1\]\n本文: 親宛のDM\n"引用"😀/u)
  assert.match(all[2], /seq=3\]\n本文: 全体への発言/u)
  assert.ok(!all.some(text => text.includes('他の席宛')))
  await waitFor(() => [1, 3].every(seq => receipts.some(receipt => receipt.seq === seq && receipt.recipient === 'bell' && receipt.result === 'delivered')), 'roomへのreceipt')
  const left = await client.callTool({ name: 'parent_leave', arguments: { endpoint_id: result.endpoint_id } })
  assert.equal(left.isError, undefined, JSON.stringify(left))
  assert.equal(members.has('bell'), false)
  // 受信を閉じたら、背景受信もclosedで終わる（張り直しを求めない）。
  assert.equal((await new Promise((resolve, reject) => {
    const child = spawn(result.wait_process.executable, [result.wait_process.args[0], '--channel', result.channel_id], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; child.stdout.on('data', data => { out += data }); child.on('error', reject); child.on('close', () => resolve(JSON.parse(out)))
  })).outcome, 'closed')
})
