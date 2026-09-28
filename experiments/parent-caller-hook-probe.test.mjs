// 実測済みpayloadの形と、一回だけ消費するcaller相関を固定する。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const script = fileURLToPath(new URL('./parent-caller-hook-probe.mjs', import.meta.url))
const runHook = (root, harness, event) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, 'hook', root, harness], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let error = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { error += value })
  child.on('error', reject)
  child.on('close', code => code ? reject(new Error(error)) : resolve(JSON.parse(output)))
  child.stdin.end(JSON.stringify(event))
})

for (const harness of ['cursor', 'grok']) test(`${harness}: 完全入力の保持・並行相関・別会話拒否・再消費拒否`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'peertable caller test '))
  await mkdir(join(root, 'contexts'))
  const client = new Client({ name: 'fixture-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [script, 'mcp', root, harness] })
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }) })
  await client.connect(transport)
  let generation = 0
  const rewrite = async (name, args, conversation = '会話A') => {
    const event = harness === 'cursor' ? {
      hook_event_name: 'preToolUse', tool_name: `MCP:${name}`, tool_input: args, conversation_id: conversation, tool_use_id: `tool-${++generation}`,
    } : {
      hook_event_name: 'PreToolUse', hookEventName: 'pre_tool_use', toolName: `peertable_probe__${name}`,
      toolInput: { tool_name: `peertable_probe__${name}`, tool_input: args }, sessionId: conversation, toolUseId: `tool-${++generation}`,
    }
    const output = await runHook(root, harness, event)
    const updated = harness === 'cursor' ? output.updated_input : output.hookSpecificOutput.updatedInput.tool_input
    const original = { ...updated }
    delete original.hook_context_id
    assert.deepEqual(original, args, '元の全引数を保持する')
    return updated
  }
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    return JSON.parse(result.content[0].text)
  }
  assert.equal((await call('parent_read', { label: '同じ入力' })).code, 'PARENT_CALLER_UNBOUND')
  const joinArgs = await rewrite('parent_join', { label: '同じ入力' })
  const endpoint = await call('parent_join', joinArgs)
  assert.equal(endpoint.code, 'PROBE_BOUND')
  assert.equal((await call('parent_join', joinArgs)).code, 'PARENT_CALLER_UNBOUND')
  const args = { label: '同じ入力', endpoint_id: endpoint.endpoint_id }
  const [first, second] = await Promise.all([rewrite('parent_read', args), rewrite('parent_read', args)])
  assert.notEqual(first.hook_context_id, second.hook_context_id, '並行した同じ入力を別のtool useへ束縛する')
  const results = await Promise.all([call('parent_read', first), call('parent_read', second)])
  assert(results.every(result => result.code === 'PROBE_SAME_CALLER'))
  for (const name of ['parent_read', 'parent_leave']) {
    const mismatch = await rewrite(name, args, '会話B')
    assert.equal((await call(name, mismatch)).code, 'PARENT_CALLER_MISMATCH')
  }
  const tampered = await rewrite('parent_read', args)
  assert.equal((await call('parent_read', { ...tampered, label: '改変' })).code, 'PARENT_CALLER_MISMATCH')
  assert.equal((await readFile(join(root, 'endpoint.json'), 'utf8')).includes('会話A'), true)
})

test('Cursorの対象外preToolUseも正規のallow objectを返す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'peertable unrelated hook '))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await runHook(root, 'cursor', { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'true' } }), { permission: 'allow' })
})
