// 公式App ServerのJSON-RPCだけを使う。Aitermの内部module/stateは参照しない。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { linkSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { failure, resolveExecutable, atomicJson, processIdentity, sameProcess, readJson } from '../parent-platform.mjs'
import { digest, renderDelivery } from '../parent-delivery.mjs'

export function codexCallerOptions(caller) {
  if (!sameProcess(caller.owner) || !['codex', 'codex.exe'].includes(basename(caller.owner.executable ?? '').toLowerCase()) || !caller.codex_home) throw failure('PARENT_CODEX_CALLER_EXECUTABLE_UNBOUND')
  return { executable: caller.owner.executable, codexHome: caller.codex_home }
}
export async function codexConnection(project, { executable = resolveExecutable('codex'), codexHome, timeout = 15000 } = {}) {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) } })
  const pending = new Map()
  let next = 0, closed = false, stderr = ''
  const rejectAll = error => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error) }; pending.clear() }
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  child.on('error', rejectAll)
  child.on('close', code => { closed = true; rejectAll(failure('PARENT_CODEX_DISCONNECTED', `App Server終了 ${code}: ${stderr}`)) })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let row
    try { row = JSON.parse(line) } catch { rejectAll(failure('PARENT_CODEX_PROTOCOL_INVALID')); return }
    const call = pending.get(row.id)
    if (!call) return
    pending.delete(row.id); clearTimeout(call.timer)
    if (row.error) call.reject(Object.assign(failure('PARENT_CODEX_RPC_REJECTED', JSON.stringify(row.error)), { rpc_rejected: true }))
    else call.resolve(row.result)
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => { pending.delete(id); reject(failure('PARENT_CODEX_RPC_TIMEOUT', method)) }, timeout)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error) } })
  })
  const close = async () => {
    if (closed) return
    const done = new Promise(resolve => child.once('close', resolve))
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2000)
    await done; clearTimeout(timer); lines.close()
  }
  try {
    await request('initialize', { clientInfo: { name: 'peertable-parent', version: '1' }, capabilities: { experimentalApi: true } })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return { request, close }
  } catch (error) { await close(); throw error }
}

export function assertCodexParentThread(response, conversation) {
  if (response.thread?.id !== conversation) throw failure('PARENT_CODEX_THREAD_MISMATCH')
  const subagent = response.thread.source?.subAgent
  if (subagent && typeof subagent === 'object' && 'thread_spawn' in subagent) throw failure('CODEX_PARENT_UNSUPPORTED', 'Codexのnative sub-agentは外部processからのキュー入力を受け付けません')
}
export async function checkCodexReceiver(project, caller, expectedCommand, { connect = codexConnection } = {}) {
  const client = await connect(project, connect === codexConnection ? codexCallerOptions(caller) : {})
  try {
    const thread = await client.request('thread/read', { threadId: caller.conversation, includeTurns: false })
    assertCodexParentThread(thread, caller.conversation)
    await client.request('thread/queue/list', { threadId: caller.conversation, limit: 1 })
    const hooks = await client.request('hooks/list', { cwds: [project] })
    const entries = hooks.data?.flatMap(group => group.hooks ?? []) ?? []
    const home = caller.codex_home
    const source = realpathSync(join(home, 'hooks.json'))
    const owned = entries.filter(hook => hook.command === expectedCommand && realpathSync(hook.sourcePath) === source && hook.handlerType === 'command' && hook.async === false)
    if (owned.length !== 2 || !['postToolUse', 'stop'].every(event => owned.some(hook => hook.eventName === event && hook.enabled === true && hook.trustStatus === 'trusted'))) throw failure('PARENT_CODEX_HOOK_UNTRUSTED')
  } finally { await client.close() }
}

export async function queueCodex(spool, { connect = codexConnection, checkTarget = () => spool.assertCurrentEndpoint() } = {}) {
  await checkTarget()
  const record = spool.claim('codex_queue')
  if (!record) return false
  let client, requestStarted = false
  try {
    client = await connect(spool.project, connect === codexConnection ? codexCallerOptions(spool.read().caller) : {})
    const state = spool.read(), text = renderDelivery(state, record)
    spool.transact(saved => { const item = spool.owned(saved, record); item.queue_text = text; item.queue_digest = digest(text); item.queue_thread = state.caller.conversation })
    const intentDir = join(spool.root, 'queue-owned'); mkdirSync(intentDir, { recursive: true })
    atomicJson(join(intentDir, `${record.delivery_id}.json`), { delivery_id: record.delivery_id, endpoint_id: spool.id, thread: state.caller.conversation, digest: digest(text) })
    await checkTarget()
    requestStarted = true
    const result = await client.request('thread/queue/add', { threadId: state.caller.conversation, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: record.delivery_id })
    if (!result.queuedSubmission?.id) throw failure('PARENT_CODEX_ACCEPTANCE_MISSING')
    const current = spool.read().records.find(item => item.delivery_id === record.delivery_id)
    spool.finish(record, { queued_submission_id: result.queuedSubmission.id, accepted_at: current.accepted_at ?? new Date().toISOString(), reason: 'codex_queue_accepted' })
    spool.update({ runtime: 'armed' })
    await spool.flushReceiptsAfterOutput()
    return true
  } catch (error) {
    const current = spool.read().records.find(item => item.delivery_id === record.delivery_id)
    // 明示拒否は投入不成立。後段hookがすでに所有した場合、その記録を優先する。
    if (!current.hook_claim) spool.finish(record, { state: requestStarted && !error.rpc_rejected ? 'unknown' : 'failed', reason: error.code ?? 'PARENT_CODEX_QUEUE_FAILED' })
    throw error
  } finally { if (client) await client.close() }
}

export async function codexHook(spool, event, write, { connect = codexConnection, checkTarget = () => spool.assertCurrentEndpoint() } = {}) {
  const state = spool.read()
  if (event.session_id !== state.caller.conversation) return false
  await checkTarget()
  const client = await connect(spool.project, connect === codexConnection ? codexCallerOptions(state.caller) : {})
  try {
    let after = null, records = []
    do {
      const result = await client.request('thread/queue/list', { threadId: state.caller.conversation, limit: 100, ...(after ? { cursor: after } : {}) })
      records.push(...(result.data ?? [])); after = result.nextCursor ?? null
    } while (after)
    for (const queued of records) {
      const saved = spool.read().records.find(record => record.delivery_id === queued.clientUserMessageId && (!record.queued_submission_id || record.queued_submission_id === queued.id) && record.queue_thread === state.caller.conversation && ['sending', 'submitted', 'unknown'].includes(record.state))
      if (!saved) continue
      const text = queued.input?.filter(input => input.type === 'text').map(input => input.text).join('')
      if (digest(text ?? '') !== saved.queue_digest) throw failure('PARENT_CODEX_QUEUE_BODY_MISMATCH')
      const intent = readJson(join(spool.root, 'queue-owned', `${saved.delivery_id}.json`))
      if (intent.thread !== state.caller.conversation || intent.digest !== saved.queue_digest || intent.endpoint_id !== spool.id) throw failure('PARENT_CODEX_QUEUE_OWNER_MISMATCH')
      const claimRoot = join(spool.root, 'queue-claims'); mkdirSync(claimRoot, { recursive: true })
      const claim = { ...intent, id: randomUUID(), owner: processIdentity(process.pid), at: new Date().toISOString() }
      const candidate = join(claimRoot, `${saved.delivery_id}.${claim.id}.candidate.json`)
      atomicJson(candidate, claim)
      try { linkSync(candidate, join(claimRoot, `${saved.delivery_id}.json`)) }
      catch (error) { if (error.code === 'EEXIST') continue; throw error }
      finally { unlinkSync(candidate) }
      const record = spool.transact(current => {
        const item = current.records.find(item => item.delivery_id === saved.delivery_id)
        if (item.hook_claim) return null
        item.hook_claim = claim
        item.hook_state = 'claimed'
        item.queued_submission_id = queued.id
        item.accepted_at ??= new Date().toISOString()
        return item
      })
      if (!record) continue
      try {
        const removed = await client.request('thread/queue/delete', { threadId: state.caller.conversation, queuedSubmissionId: queued.id })
        if (removed.deleted !== true) throw failure('PARENT_CODEX_DELETE_UNCONFIRMED')
        spool.transact(current => { const item = spool.owned(current, record); item.hook_state = 'deleted'; item.hook_turn = event.turn_id })
        await checkTarget()
        await write(event.hook_event_name === 'Stop' ? { decision: 'block', reason: text } : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
        spool.transact(current => { const saved = spool.owned(current, record); saved.hook_state = 'output_complete' })
        const complete = spool.read().records.find(item => item.delivery_id === record.delivery_id)
        spool.finish(record, { queued_submission_id: queued.id, accepted_at: complete.accepted_at, reason: 'codex_hook_output_complete', resolve_unknown: true })
      } catch (error) { spool.finish(record, { state: 'unknown', reason: error.code ?? 'PARENT_CODEX_HOOK_OUTPUT_UNKNOWN' }); throw error }
      await spool.flushReceiptsAfterOutput()
      return true
    }
    return false
  } finally { await client.close() }
}
