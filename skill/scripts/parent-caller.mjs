// 公式hookとMCP要求を一度だけ消費する相関。時刻やcwdでは本人を選ばない。
import { existsSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { parentHome, atomicJson, readJson, failure, sameProcess, harnessProcess } from './parent-platform.mjs'
import { digest, ParentSpool } from './parent-delivery.mjs'

const UUID = /^[0-9a-f-]{36}$/u
export function clientHarness(client) {
  const name = client?.name ?? ''
  if (name === 'codex-mcp-client') return 'codex'
  if (name === 'claude-code') return 'claude'
  if (name === 'Cursor' || name === 'cursor-vscode' || name.startsWith('cursor-vscode ')) return 'cursor'
  if (name === 'grok-shell-peertable_parent') return 'grok'
  throw failure('PARENT_CLIENT_UNSUPPORTED', `未確認のMCP client: ${name}`)
}
export function assertClaudeParent(event) {
  if (event.agent_id) throw failure('CLAUDE_PARENT_SUBAGENT_UNSUPPORTED', 'agent_id付きのClaude会話は親のasyncRewake受信に対応しません')
}
export function hookContext(harness, event) {
  if (harness === 'claude') assertClaudeParent(event)
  const conversation = harness === 'grok' ? event.sessionId : harness === 'cursor' ? event.conversation_id : event.session_id
  const use = harness === 'grok' ? event.toolUseId : event.tool_use_id
  const fullName = harness === 'grok' ? event.toolName : event.tool_name
  const name = /parent_(join|read|leave)$/u.exec(fullName ?? '')?.[0]
  const envelope = harness === 'grok' ? event.toolInput : event.tool_input
  const input = harness === 'grok' ? envelope?.tool_input : envelope
  if (!name) return null
  if (!conversation || !use || !input || typeof input !== 'object' || (harness === 'grok' && envelope?.tool_name !== fullName)) throw failure('PARENT_CALLER_UNBOUND')
  const owner = harnessProcess(harness)
  if (!owner) throw failure('PARENT_HARNESS_IDENTITY_UNBOUND')
  const id = randomUUID()
  const context = { id, harness, conversation, use, name, agent_id: harness === 'claude' ? event.agent_id ?? null : null, input_digest: digest(input), owner, created_at: Date.now(), call_generation: randomUUID() }
  const key = harness === 'claude' ? digest(['claude', use]) : id
  atomicJson(join(parentHome(), 'contexts', `${key}.json`), context)
  return { context, updated: harness === 'grok' ? { ...envelope, tool_input: { ...input, hook_context_id: id } } : { ...input, hook_context_id: id } }
}
export function consumeCaller(harness, request, requestId) {
  const args = request.params.arguments ?? {}
  if (harness === 'codex') {
    const conversation = request.params._meta?.threadId
    if (typeof conversation !== 'string' || !conversation) throw failure('PARENT_CALLER_UNBOUND')
    const owner = harnessProcess(harness)
    if (!owner) throw failure('PARENT_HARNESS_IDENTITY_UNBOUND')
    const codex_home = realpathSync(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
    if (typeof requestId !== 'string' && typeof requestId !== 'number') throw failure('PARENT_REQUEST_ID_UNBOUND')
    return { harness, conversation, owner, codex_home, use: String(requestId), name: request.params.name }
  }
  const id = harness === 'claude' ? request.params._meta?.['claudecode/toolUseId'] : args.hook_context_id
  if (typeof id !== 'string' || !id || (harness !== 'claude' && !UUID.test(id))) throw failure('PARENT_CALLER_UNBOUND')
  const key = harness === 'claude' ? digest(['claude', id]) : id
  const file = join(parentHome(), 'contexts', `${key}.json`)
  const consumed = `${file}.consumed-${randomUUID()}`
  try { renameSync(file, consumed) } catch (error) { if (error.code === 'ENOENT') throw failure('PARENT_CALLER_UNBOUND'); throw error }
  const context = readJson(consumed)
  if (harness === 'claude') assertClaudeParent(context)
  const original = { ...args }; delete original.hook_context_id
  if (context.harness !== harness || context.name !== request.params.name || context.input_digest !== digest(original) || !sameProcess(context.owner) || Date.now() - context.created_at > 30000) throw failure('PARENT_CALLER_MISMATCH')
  return context
}
export function registerEndpoint(spool) {
  atomicJson(join(parentHome(), 'endpoints', `${spool.id}.json`), { endpoint_id: spool.id, project: realpathSync(spool.project) })
}
export function endpointById(id) {
  if (!UUID.test(id ?? '')) throw failure('PARENT_ENDPOINT_INVALID')
  const file = join(parentHome(), 'endpoints', `${id}.json`)
  if (!existsSync(file)) throw failure('PARENT_ENDPOINT_NOT_FOUND')
  const index = readJson(file)
  return new ParentSpool(index.project, id)
}
export function endpointsFor({ project = null, caller = null } = {}) {
  const dir = join(parentHome(), 'endpoints')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^[0-9a-f-]{36}\.json$/u.test(name)).map(name => endpointById(name.slice(0, -5)))
    .filter(spool => (!project || realpathSync(project) === realpathSync(spool.project)) && (!caller || (spool.read().caller.harness === caller.harness && spool.read().caller.conversation === caller.conversation)))
}
export function verifyCaller(spool, caller) {
  const binding = spool.read().caller
  if (binding.harness !== caller.harness || binding.conversation !== caller.conversation || binding.owner.pid !== caller.owner.pid || binding.owner.started !== caller.owner.started) throw failure('PARENT_CALLER_MISMATCH')
}
export function saveJoinResult(caller, result) {
  atomicJson(join(parentHome(), 'join-results', `${digest([caller.harness, caller.conversation, caller.use])}.json`), { caller, result })
}
export function verifyJoinHook(harness, event, owner) {
  const fullName = harness === 'grok' ? event.toolName : event.tool_name
  if (!/parent_join$/u.test(fullName ?? '')) return null
  if (harness === 'cursor' && event.hook_event_name === 'afterMCPExecution' && event.mcp_server_name !== 'peertable_parent') return null
  const conversation = harness === 'grok' ? event.sessionId : harness === 'cursor' ? event.conversation_id : event.session_id
  const use = harness === 'grok' ? event.toolUseId : event.tool_use_id
  if (!conversation || !use) throw failure('PARENT_CALLER_UNBOUND')
  const file = join(parentHome(), 'join-results', `${digest([harness, conversation, use])}.json`)
  if (!existsSync(file)) throw failure('PARENT_JOIN_RESULT_UNBOUND')
  const saved = readJson(file)
  const find = value => {
    if (typeof value === 'string') { try { return find(JSON.parse(value)) } catch { return null } }
    if (!value || typeof value !== 'object') return null
    if (value.schema === 'peertable.parent-join-result.v1') return value
    for (const child of Object.values(value)) { const found = find(child); if (found) return found }
    return null
  }
  const result = find(harness === 'grok' ? event.toolResult : event.tool_output ?? event.tool_response ?? event.result_json)
  if (!result || result.endpoint_id !== saved.result.endpoint_id || owner.pid !== saved.caller.owner.pid || owner.started !== saved.caller.owner.started) throw failure('PARENT_JOIN_RESULT_MISMATCH')
  return result
}
