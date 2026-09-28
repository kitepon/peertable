import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ParentSpool, PAGE_CHARS } from '../skill/scripts/parent-delivery.mjs'
import { processIdentity, atomicJson } from '../skill/scripts/parent-platform.mjs'

const waitFor = async condition => {
  const deadline = Date.now() + 30000
  while (!condition()) { if (Date.now() >= deadline) throw new Error('stdio完了の観測期限を超過しました'); await delay(10) }
}
test('実SDK stdioの異なるread要求IDを相関し、長文はfinal stdout完了だけでackする', async t => {
  const project = mkdtempSync(join(tmpdir(), 'peertable-parent-stdio-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const spools = [], receipts = []
  const api = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/members')) return res.end(JSON.stringify({ members: spools.map(spool => ({ name: spool.read().name, delivery: { kind: 'parent_receiver', endpoint_id: spool.id } })) }))
    if (req.url.endsWith('/deliveries')) { receipts.push(JSON.parse(raw)); return res.end('{"ok":true}') }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => api.close(resolve)))
  const credential = join(project, 'token'); writeFileSync(credential, 'fixture', { mode: 0o600 })
  for (const name of ['long-parent', 'short-parent']) spools.push(ParentSpool.create(project, { name, room: 'fixture', start_seq: 0, server_url: `http://127.0.0.1:${api.address().port}`, credential, harness: 'codex', caller: { harness: 'codex', conversation: name, owner: processIdentity(process.pid) } }))
  atomicJson(join(project, '.team', 'setup-state.json'), { room: 'fixture', server_url: spools[0].read().server_url })
  const original = '日本語😀'.repeat(PAGE_CHARS)
  const long = spools[0].saveEvent({ type: 'parent_dm', seq: 1, body: original }), short = spools[1].saveEvent({ type: 'parent_dm', seq: 2, body: '短文' })
  const requestsFile = join(project, 'requests.jsonl')
  // 本人照合はcaller試験が担当。この試験は実SDKのschema parse/extra/stdio完了境界を通す。
  const code = String.raw`import {runParentClient} from ${JSON.stringify(new URL('./parent-client.mjs', import.meta.url).href)};import {ParentSpool} from ${JSON.stringify(new URL('../skill/scripts/parent-delivery.mjs', import.meta.url).href)};import {appendFileSync} from 'node:fs';const project=process.argv[1];const endpoint=id=>new ParentSpool(project,id);await runParentClient({resolveEndpoint:endpoint,resolveCaller:(harness,request,requestId)=>{appendFileSync(process.argv[2],JSON.stringify({requestId,parsedId:request.id??null})+'\n');return {...endpoint(request.params.arguments.endpoint_id).read().caller,use:String(requestId)}}});`
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', code, project, requestsFile], stderr: 'pipe' })
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk })
  const client = new Client({ name: 'codex-mcp-client', version: 'fixture' })
  t.after(() => client.close())
  try { await client.connect(transport) } catch (error) { throw new Error(`${error.message}\n${stderr}`, { cause: error }) }
  const read = (spool, delivery, token) => client.callTool({ name: 'parent_read', arguments: { endpoint_id: spool.id, delivery_id: delivery.delivery_id, ...(token ? { continuation_token: token } : {}) } })
  const [first, other] = await Promise.all([read(spools[0], long), read(spools[1], short)])
  assert.equal(first.isError, undefined, stderr); assert.equal(other.isError, undefined, stderr)
  let page = first.structuredContent.page, combined = page.event.body
  await waitFor(() => spools[0].read().records[0].claim.offset === page.offset + page.event.body.length && spools[1].read().records[0].state === 'submitted')
  assert.equal(spools[0].read().records[0].receipt, null)
  assert.ok(!receipts.some(receipt => receipt.recipient === 'long-parent'))
  let pages = 1
  while (page.continuation_token) {
    const next = await read(spools[0], long, page.continuation_token)
    assert.equal(next.isError, undefined, stderr)
    page = next.structuredContent.page; combined += page.event.body; pages++
    await waitFor(() => !spools[0].read().records[0].claim.page_inflight)
  }
  await waitFor(() => spools[0].read().records[0].receipt?.pending === false)
  assert.equal(combined, original); assert.ok(pages > 1)
  assert.equal(receipts.filter(receipt => receipt.recipient === 'long-parent').length, 1)
  assert.equal(spools[0].read().records[0].state, 'submitted')
  const requests = readFileSync(requestsFile, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(new Set(requests.map(request => request.requestId)).size, pages + 1)
  assert.ok(requests.every(request => typeof request.requestId === 'number' && request.parsedId === null))
})
