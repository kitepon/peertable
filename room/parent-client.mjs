// 親専用stdio MCP。通常席clientのchannelや読了cursorとは独立した2tool。
// 親への配送はAitermと同じ方式（aiterm-steer-delivery）で、親の特定もAitermと同じ根拠で行う。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'node:url'
import { readJson, failure, harnessProcess } from '../skill/scripts/parent-platform.mjs'
import { endpointById, verifyCaller } from '../skill/scripts/parent-caller.mjs'
import { joinEndpoint, setupFor, stopEndpoint, actorEnvironment } from '../skill/scripts/parent-runtime.mjs'
import { PEERTABLE_PROFILE, clientHarness, entries, parentFromRequest, parentServerName, steer } from '../skill/scripts/parent-steer.mjs'
import { RoomApi } from '../skill/scripts/room-api.mjs'

const tools = [
  { name: 'parent_join', description: 'この会話を親としてroomの受信者に登録する。以後、親宛の発言はこの会話へ届く（作業中なら今のturnへ差し込み、待機中なら新しいturnで届く）。wait_processが返った時は、それを背景processとして起動する。', inputSchema: { type: 'object', properties: { project: { type: 'string' }, name: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, mission: { type: 'string' } }, required: ['project', 'name'], additionalProperties: false } },
  { name: 'parent_leave', description: 'この会話の受信登録だけを閉じる。円卓・親harnessを終了しない。', inputSchema: { type: 'object', properties: { endpoint_id: { type: 'string' } }, required: ['endpoint_id'], additionalProperties: false } },
]
const instructions = 'Peertableの親登録はparent_join。親宛のroom発言はAitermの子の回答と同じ方式で届く。' +
  'Codex・Claude Codeは何もしなくてよい（作業中はそのturnへ、待機中は新しいturnで届く）。' +
  'CursorとGrokには、parent_joinの結果にwait_processが付く。そのexecutableとargsをそのまま親の背景process APIへ渡して起動する。' +
  '完了したら出力のdeliveriesが本文で、next_wait_processを同じ方法で起動し直すと次も受け取れる。Cursorは作業中なら次のtool返りにも差し込まれる。'

export async function runParentClient({ resolveEndpoint = endpointById, identify = parentFromRequest, owner = harnessProcess } = {}) {
  const version = readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version
  const server = new Server({ name: parentServerName, version }, { capabilities: { tools: {} }, instructions })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const client = server.getClientVersion()
      const harness = clientHarness(client)
      const parentProcess = owner(harness)
      if (!parentProcess) throw failure('PARENT_HARNESS_IDENTITY_UNBOUND', '親harnessのprocessを確認できません')
      const args = request.params.arguments ?? {}, name = request.params.name
      let result, marker = null
      if (name === 'parent_join') {
        if (!args.project || !args.name) throw failure('PARENT_JOIN_ARGUMENT_INVALID')
        const parent = identify(client, request.params._meta)
        if (harness === 'codex') await steer.verifyCodexParent(PEERTABLE_PROFILE, parent)
        const caller = { harness, owner: parentProcess, ...(harness === 'codex' ? { codex: parent } : {}) }
        const display = Object.fromEntries(['model', 'effort', 'mission'].filter(key => args[key] !== undefined).map(key => [key, args[key]]))
        const spool = await joinEndpoint(args.project, args.name, caller, parent, display)
        const channel = spool.read().channel
        if (harness === 'cursor') marker = steer.channelMarker({ channel_id: channel.channel_id })
        result = { schema: 'peertable.parent-join-result.v2', endpoint_id: spool.id, state: spool.read().state, harness, channel_id: channel.channel_id,
          wait_process: ['cursor', 'grok'].includes(harness) ? steer.channelReceiveProcess(entries.receive, channel.channel_id) : null,
          actor_environment: actorEnvironment(spool.project, args.name), error_code: null }
      } else if (name === 'parent_leave') {
        const spool = resolveEndpoint(args.endpoint_id)
        verifyCaller(spool, { harness, owner: parentProcess })
        await stopEndpoint(spool, 'PARENT_LEFT')
        const api = new RoomApi(setupFor(spool.project), { credential: spool.read().credential })
        if ((await api.members()).some(member => member.delivery?.endpoint_id === spool.id)) await api.request(`members/${encodeURIComponent(spool.read().name)}`, { method: 'DELETE' })
        result = { schema: 'peertable.parent-leave-result.v1', endpoint_id: spool.id, state: 'stopped' }
      } else throw failure('PARENT_TOOL_UNKNOWN')
      // Cursorのhookはtool結果の印でchannelを実際の会話へ結ぶ（structuredContentと本文の両方に載せる）。
      const text = JSON.stringify(result) + (marker ? `\n${marker.text}` : '')
      return { content: [{ type: 'text', text }], structuredContent: { ...result, ...(marker?.structured ?? {}) } }
    } catch (error) {
      const result = { schema: 'peertable.parent-error.v1', state: 'failed', error_code: error.delivery_code ?? error.code ?? 'PARENT_REQUEST_FAILED', detail: error.message }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
}
