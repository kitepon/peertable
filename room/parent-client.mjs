// 親専用stdio MCP。通常席clientのchannelや読了cursorとは独立した3tool。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'node:url'
import { readJson, hookCommand, failure } from '../skill/scripts/parent-platform.mjs'
import { clientHarness, consumeCaller, endpointById, verifyCaller, saveJoinResult } from '../skill/scripts/parent-caller.mjs'
import { joinEndpoint, setupFor, stopEndpoint, actorEnvironment } from '../skill/scripts/parent-runtime.mjs'
import { waitReceipt } from '../skill/scripts/parent-receivers/background.mjs'
import { checkCodexReceiver } from '../skill/scripts/parent-receivers/codex.mjs'
import { RoomApi } from '../skill/scripts/room-api.mjs'
import { runtimeDigest } from '../skill/scripts/runtime-digest.mjs'

const hookEntry = fileURLToPath(new URL('../skill/scripts/parent-hook.mjs', import.meta.url))
const commonProperties = { hook_context_id: { type: 'string', description: 'Peertable公式hook専用。モデルは省略する。' } }
const tools = [
  { name: 'parent_join', description: '既存のこの会話を親receiverとして登録・再武装する。必要な背景toolの完成済み入力を返す。', inputSchema: { type: 'object', properties: { project: { type: 'string' }, name: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, mission: { type: 'string' }, ...commonProperties }, required: ['project', 'name'], additionalProperties: false } },
  { name: 'parent_read', description: 'この会話の親配送本文を回収する。継続tokenがある間は全文の受付は未確定。必要な次の背景tool入力も返す。', inputSchema: { type: 'object', properties: { endpoint_id: { type: 'string' }, delivery_id: { type: 'string' }, continuation_token: { type: 'string' }, ...commonProperties }, required: ['endpoint_id'], additionalProperties: false } },
  { name: 'parent_leave', description: 'この会話の受信登録だけを閉じる。円卓・親harnessを終了しない。', inputSchema: { type: 'object', properties: { endpoint_id: { type: 'string' }, ...commonProperties }, required: ['endpoint_id'], additionalProperties: false } },
]
export async function runParentClient({ resolveCaller = consumeCaller, resolveEndpoint = endpointById } = {}) {
  const version = readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version
  const sourceDigest = runtimeDigest()
  const server = new Server({ name: 'peertable_parent', version }, { capabilities: { tools: {} }, instructions: 'Peertableの親登録はparent_join。wait_process.native_toolがある場合は完成済みinputをそのnative背景toolへ渡す。背景完了にdelivery_idがあるときはparent_readで回収し、continuation_tokenがある間は同じ配送を続けて回収する。次のwait_processも登録する。期限controlは同じparent_join/parent_readで再武装する。hook_context_idは生成・転記しない。' })
  const writes = new Map()
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const requestId = extra.requestId
      const harness = clientHarness(server.getClientVersion()), caller = resolveCaller(harness, request, requestId)
      caller.peertable_source_digest = sourceDigest
      if (sourceDigest !== runtimeDigest()) throw failure('PARENT_RESTART_REQUIRED')
      const args = request.params.arguments ?? {}, name = request.params.name
      let result
      if (name === 'parent_join') {
        if (!args.project || !args.name) throw failure('PARENT_JOIN_ARGUMENT_INVALID')
        if (harness === 'codex') await checkCodexReceiver(args.project, caller, hookCommand(process.execPath, [hookEntry, 'codex']))
        const display = Object.fromEntries(['model', 'effort', 'mission'].filter(key => args[key] !== undefined).map(key => [key, args[key]]))
        const spool = await joinEndpoint(args.project, args.name, caller, display)
        result = { schema: 'peertable.parent-join-result.v1', endpoint_id: spool.id, state: spool.read().state, harness, wait_process: ['cursor', 'grok'].includes(harness) ? waitReceipt(spool) : null, actor_environment: actorEnvironment(spool.project, args.name), error_code: null }
        if (harness !== 'codex') saveJoinResult(caller, result)
      } else if (name === 'parent_read') {
        const spool = resolveEndpoint(args.endpoint_id)
        verifyCaller(spool, caller)
        await spool.assertCurrentEndpoint()
        spool.recover()
        const page = spool.page(args.delivery_id, args.continuation_token)
        result = { schema: 'peertable.parent-read-result.v1', endpoint_id: spool.id, page: page?.result ?? null, wait_process: ['cursor', 'grok'].includes(harness) ? waitReceipt(spool) : null }
        if (page) writes.set(requestId, { spool, page })
      } else if (name === 'parent_leave') {
        const spool = resolveEndpoint(args.endpoint_id)
        verifyCaller(spool, caller)
        await stopEndpoint(spool)
        const api = new RoomApi(setupFor(spool.project), { credential: spool.read().credential })
        if ((await api.members()).some(member => member.delivery?.endpoint_id === spool.id)) await api.request(`members/${encodeURIComponent(spool.read().name)}`, { method: 'DELETE' })
        result = { schema: 'peertable.parent-leave-result.v1', endpoint_id: spool.id, state: 'stopped' }
      } else throw failure('PARENT_TOOL_UNKNOWN')
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) {
      const result = { schema: 'peertable.parent-error.v1', state: 'failed', error_code: error.code ?? 'PARENT_REQUEST_FAILED', detail: error.message }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true }
    }
  })
  const transport = new StdioServerTransport()
  // SDKのbuffer受付だけでackせず、実stdoutのwrite callback後に最終pageを確定する。
  transport.send = message => new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, async error => {
      const pending = writes.get(message.id)
      writes.delete(message.id)
      if (error) {
        if (pending) pending.spool.finish(pending.page.record, { state: 'unknown', reason: 'PARENT_MCP_OUTPUT_UNKNOWN' })
        reject(error); return
      }
      if (pending) {
        try {
          pending.spool.pageWritten(pending.page)
          await pending.spool.flushReceipts(new RoomApi(setupFor(pending.spool.project), { credential: pending.spool.read().credential }))
        } catch (receiptError) { process.stderr.write(`${receiptError.code ?? 'PARENT_RECEIPT_FAILED'}: ${receiptError.message}\n`) }
      }
      resolve()
    })
  })
  await server.connect(transport)
}
