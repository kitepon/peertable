#!/usr/bin/env node
// 公式Cursor/Grokの事前hookが、実MCP入力へ相関を渡すかを観測する。
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const [mode, root, harness] = process.argv.slice(2)
const self = fileURLToPath(import.meta.url)
const record = (dir, value) => appendFile(join(dir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`)
const readJson = path => readFile(path, 'utf8').then(JSON.parse)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// hook設定のcommand欄は各OSの標準shellに適合する。
const command = args => process.platform === 'win32'
  ? `& ${args.map(arg => `'${arg.replaceAll("'", "''")}'`).join(' ')}`
  : args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')

async function init(target) {
  if (!['cursor', 'grok'].includes(target)) throw new Error('PROBE_HARNESS_INVALID')
  const dir = await mkdtemp(join(tmpdir(), `peertable ${target} 本人性 `))
  execFileSync('git', ['init', '--quiet', dir])
  await mkdir(join(dir, 'contexts'))
  const invocation = command([process.execPath, self, 'hook', dir, target])
  const mcp = { command: process.execPath, args: [self, 'mcp', dir, target] }
  if (target === 'cursor') {
    await mkdir(join(dir, '.cursor'))
    await writeFile(join(dir, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { peertable_probe: mcp } }))
    await writeFile(join(dir, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: {
      preToolUse: [{ command: invocation }], postToolUse: [{ command: invocation }],
      postToolUseFailure: [{ command: invocation }], afterMCPExecution: [{ command: invocation }],
      stop: [{ command: invocation }], sessionEnd: [{ command: invocation }],
    } }))
  } else {
    await mkdir(join(dir, '.grok/hooks'), { recursive: true })
    // Grok固有の正本へ置き、互換hookの二重読込みを避ける。
    await writeFile(join(dir, '.grok/config.toml'), `[mcp_servers.peertable_probe]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\n`)
    await writeFile(join(dir, '.grok/hooks/peertable-probe.json'), JSON.stringify({ hooks: Object.fromEntries(
      ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'].map(event => [event, [{ hooks: [{ type: 'command', command: invocation }] }]])
    ) }))
  }
  const prompt = '受信本人性の小fixtureです。peertable_probeのparent_joinをlabel="同じ入力"で1回呼び、返却されたendpoint_idを使ってparent_readをlabel="同じ入力"で2回並列に呼び、その後parent_leaveを1回呼んでください。hook_context_idは入力しないでください。全結果のcodeだけ報告してください。ファイル編集や別のtoolは不要です。'
  await writeFile(join(dir, 'prompt.txt'), prompt)
  console.log(JSON.stringify({ root: dir, harness: target, prompt }))
}

async function hook(dir, target) {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const event = JSON.parse(raw)
  await record(dir, { kind: 'hook', harness: target, event })
  const pre = target === 'cursor' ? event.hook_event_name === 'preToolUse' : event.hook_event_name === 'PreToolUse'
  const name = target === 'cursor' ? event.tool_name : event.toolName
  const ours = target === 'cursor' ? /^MCP:parent_(join|read|leave)$/.test(name ?? '') : /peertable_probe.*parent_(join|read|leave)/.test(name ?? '')
  if (!pre || !ours) {
    console.log(pre && target === 'cursor' ? '{"permission":"allow"}' : '{}')
    return
  }
  const input = target === 'cursor' ? event.tool_input : event.toolInput
  const conversation = target === 'cursor' ? event.conversation_id : event.sessionId
  const use = target === 'cursor' ? event.tool_use_id : event.toolUseId
  if (!conversation || !use || !input || typeof input !== 'object') {
    await record(dir, { kind: 'unbound', name })
    console.log(target === 'cursor' ? JSON.stringify({ permission: 'deny', agent_message: 'PARENT_CALLER_UNBOUND' }) : JSON.stringify({ decision: 'deny', reason: 'PARENT_CALLER_UNBOUND' }))
    return
  }
  const id = randomUUID()
  const argumentsInput = target === 'grok' ? input.tool_input : input
  if (!argumentsInput || typeof argumentsInput !== 'object' || (target === 'grok' && input.tool_name !== name)) throw new Error('PROBE_MCP_INPUT_SHAPE_UNKNOWN')
  await writeFile(join(dir, 'contexts', `${id}.json`), JSON.stringify({ id, conversation, use, name, input, digest: digest(argumentsInput) }))
  const updated = target === 'grok'
    ? { ...input, tool_input: { ...argumentsInput, hook_context_id: id } }
    : { ...input, hook_context_id: id }
  await record(dir, { kind: 'rewrite', id, conversation, use, name, input, updated })
  console.log(JSON.stringify(target === 'cursor'
    ? { permission: 'allow', updated_input: updated }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }))
}

async function mcp(dir, target) {
  const server = new Server({ name: 'peertable-caller-probe', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['parent_join', 'parent_read', 'parent_leave'].map(name => ({
    name, description: '公式事前hookと同じ会話の照合fixture', inputSchema: { type: 'object', properties: {
      label: { type: 'string' }, endpoint_id: { type: 'string' }, hook_context_id: { type: 'string', description: '製品hook専用。モデルは省略する' },
    }, required: ['label'], additionalProperties: false },
  })) }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments ?? {}
    const name = request.params.name
    await record(dir, { kind: 'mcp_call', name, args, meta: request.params._meta ?? null, client: server.getClientVersion() })
    let code = 'PARENT_CALLER_UNBOUND'
    let endpoint
    const id = args.hook_context_id
    if (typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) {
      try {
        await rename(join(dir, 'contexts', `${id}.json`), join(dir, 'contexts', `${id}.consumed.json`))
        const context = await readJson(join(dir, 'contexts', `${id}.consumed.json`))
        const original = { ...args }
        delete original.hook_context_id
        if (context.digest !== digest(original) || !context.name.endsWith(name)) code = 'PARENT_CALLER_MISMATCH'
        else if (name === 'parent_join') {
          endpoint = { endpoint_id: randomUUID(), conversation: context.conversation }
          await writeFile(join(dir, 'endpoint.json'), JSON.stringify(endpoint))
          code = 'PROBE_BOUND'
        } else {
          endpoint = await readJson(join(dir, 'endpoint.json'))
          code = endpoint.conversation === context.conversation && endpoint.endpoint_id === args.endpoint_id ? 'PROBE_SAME_CALLER' : 'PARENT_CALLER_MISMATCH'
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        code = 'PARENT_CALLER_UNBOUND'
      }
    }
    const result = { code, endpoint_id: endpoint?.endpoint_id ?? null }
    await record(dir, { kind: 'mcp_result', name, result })
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: !code.startsWith('PROBE_') }
  })
  await server.connect(new StdioServerTransport())
}

if (mode === 'init') await init(root)
else if (mode === 'hook') await hook(root, harness)
else if (mode === 'mcp') await mcp(root, harness)
else throw new Error('PROBE_MODE_INVALID: init / hook / mcpを指定してください')
