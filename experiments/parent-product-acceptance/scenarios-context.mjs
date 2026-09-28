// 配布物と試験親を使う実操作。既存runnerのclosureを受け取るが、障害操作と判定はこのmoduleが所有する。
import { createServer, request } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { judgeAudience, sha256 } from './evidence.mjs'
import { isDeepStrictEqual } from 'node:util'
import { scenarioPlan, scenarioNames } from './scenarios.mjs'
import { readJsonl } from './harness.mjs'

const fail = (code, detail) => { throw Object.assign(new Error(detail), { code }) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, probe, ms = 300000, every = 1000) => {
  const deadline = Date.now() + ms
  for (;;) { const value = await probe(); if (value) return value; if (Date.now() >= deadline) fail('ACCEPTANCE_TIMEOUT', label); await sleep(every) }
}

// 試験roomの手前だけに置くproxy。SSE切断とreceipt HTTP失敗を製品を改造せず実境界へ注入する。
// runnerの投稿APIはbackendへ向け、親のsetup-state.server_urlだけをproxyのURLへ向ける。
export async function createScenarioProxy({ backend, artifact }) {
  const sockets = new Set(), sourceResponses = new Set(), upstreams = new Set()
  const events = []; let sourceBlocked = false, receiptBlocked = false
  const note = (kind, fields = {}) => { const row = { at: new Date().toISOString(), kind, ...fields }; events.push(row); if (artifact) appendFileSync(artifact, JSON.stringify(row) + '\n'); return row }
  const source = path => /^\/api\/[^/]+\/(?:events|messages|summary)(?:\?|$)/u.test(path)
  const server = createServer((req, res) => {
    const sourceRequest = req.method === 'GET' && source(req.url)
    note('request', { method: req.method, path: req.url, source: sourceRequest })
    if ((sourceBlocked && sourceRequest) || (receiptBlocked && req.method === 'POST' && /\/deliveries(?:\?|$)/u.test(req.url))) {
      const kind = sourceRequest ? 'source_http_failed' : 'receipt_http_failed'
      res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'acceptance_owned_boundary_failure' })); note(kind, { path: req.url }); return
    }
    const target = new URL(req.url, backend)
    const upstream = request(target, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers)
      if (sourceRequest) { sourceResponses.add(res); res.once('close', () => sourceResponses.delete(res)) }
      response.pipe(res); response.once('error', error => { note('upstream_read_failed', { code: error.code }); res.destroy(error) })
    })
    upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream))
    upstream.once('error', error => { note('upstream_failed', { code: error.code }); if (!res.headersSent) res.writeHead(502); res.end() })
    res.once('close', () => { if (!res.writableEnded) upstream.destroy() }); req.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`, artifact, events,
    disconnectSource() { sourceBlocked = true; const interrupted = sourceResponses.size; for (const res of sourceResponses) res.destroy(); return note('source_disconnected', { interrupted }) },
    reconnectSource() { sourceBlocked = false; return note('source_restored') },
    failReceipts() { receiptBlocked = true; return note('receipt_blocked') },
    restoreReceipts() { receiptBlocked = false; return note('receipt_restored') },
    async close() { sourceBlocked = false; receiptBlocked = false; for (const upstream of upstreams) upstream.destroy(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); note('proxy_closed'); return { closed: !server.listening } },
  }
}

// parent_readの公式tool出力をraw JSONLから取得する。本文はJSON decodeだけで、任意の置換をしない。
// 試験専用artifactの正規path。用途名が拡張子(.json/.jsonl/.mjs)を持てばそのまま使い、無ければ.jsonを付ける。
export const artifactPath = (dir, label) => join(dir, /\.(?:json|jsonl|mjs)$/u.test(label) ? label : `${label}.json`)
// join後の親最終返答が会話に確定した(応答があり、未確定の書込み末尾が無い)ことの観測。
export const finalReplyConfirmed = seen => seen.replies.length > 0 && seen.pending_tail === 0
// spoolの未読保持state(途中offset・receipt無し)と、同じoffsetまで返した実tool途中pageが同時に揃った時だけ返す。
export const intermediatePageMatch = (record, pages) => {
  if (record?.state !== 'sending' || !(record.claim.offset > 0 && record.claim.offset < record.event.body.length) || record.receipt !== null) return null
  return pages.find(item => item.page.complete === false && item.page.offset + item.page.event.body.length === record.claim.offset) ?? null
}
export function nativeReadPages(harness, file, deliveryId) {
  const rows = readFileSync(file, 'utf8').split('\n'); rows.pop()
  const pages = []; let turn = null
  const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? '').join('') : ''
  for (const [order, line] of rows.entries()) {
    const row = JSON.parse(line), payload = row.payload ?? {}
    if (harness === 'claude' && row.type === 'user' && row.promptId) turn = row.promptId
    if (harness === 'codex' && (row.type === 'turn_context' || (row.type === 'event_msg' && ['task_started', 'turn_started'].includes(payload.type)))) turn = payload.turn_id ?? turn
    let outputs = []
    if (harness === 'claude' && row.type === 'user') outputs = (Array.isArray(row.message?.content) ? row.message.content : []).filter(part => part.type === 'tool_result').map(part => text(part.content))
    if (harness === 'codex' && row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)) outputs = [text(payload.output)]
    for (const output of outputs) {
      const candidates = [output]
      // MCPの公式text block包装だけを読む。未知包装を正規表現で本文へ変換しない。
      try { const outer = JSON.parse(output); for (const part of outer.content ?? []) if (part.type === 'text') candidates.push(part.text); if (outer.structuredContent) candidates.push(JSON.stringify(outer.structuredContent)) } catch (error) { if (!(error instanceof SyntaxError)) throw error }
      for (const candidate of candidates) {
        let value; try { value = JSON.parse(candidate) } catch (error) { if (error instanceof SyntaxError) continue; throw error }
        const page = value.schema === 'peertable.parent-read-page.v1' ? value : value.schema === 'peertable.parent-read-result.v1' ? value.page : null
        if (page?.delivery_id === deliveryId && !pages.some(item => item.order === order && item.page.offset === page.offset)) pages.push({ order, turn_id: turn, session: row.sessionId ?? null, page })
      }
    }
  }
  return pages
}

export function assembleNativePages(pages) {
  if (!pages.length) return null
  let offset = 0, body = ''
  const first = pages[0].page
  for (const { page } of pages) {
    if (page.offset !== offset || page.delivery_id !== first.delivery_id || page.digest !== first.digest || page.total_characters !== first.total_characters || typeof page.event?.body !== 'string') fail('ACCEPTANCE_PAGE_NATIVE_SEQUENCE', '実tool出力pageの順序・identityが不一致です')
    body += page.event.body; offset += page.event.body.length
    if (page.complete !== (offset === page.total_characters)) fail('ACCEPTANCE_PAGE_NATIVE_FINAL', '最終pageのcompleteが原文長と不一致です')
  }
  return pages.at(-1).page.complete && offset === first.total_characters ? { body, first, final: pages.at(-1) } : null
}

// 判定は実会話・room receipt・原文保存を直接使い、未収集のscope.checksに依存しない。
export function noToolsReception({ posted, record, receipt, seen, session, runtime }) {
  if (record?.event?.body !== posted.body) fail('ACCEPTANCE_NO_TOOLS_BODY_LOST', '全toolなしの原文を製品が保持していません')
  const delivery = seen.deliveries.find(item => item.delivery_id === record.delivery_id && item.session === session && item.body === posted.body)
  const reply = delivery && seen.replies.find(item => item.session === session && item.turn_id && item.order > delivery.order && item.text.includes(posted.nonce))
  if (record.state === 'submitted' && receipt?.state === 'delivered' && delivery?.turn_id && reply) return { state: 'native_received', delivery, reply }
  if (runtime === 'rearm_pending' && ['ready', 'sending'].includes(record.state) && receipt?.state !== 'delivered') return { state: 'rearm_pending', delivery: null, reply: null }
  fail('ACCEPTANCE_NO_TOOLS_STATE_UNEXPLAINED', `実返答/receipt/原文保持を説明できません: ${runtime}/${record.state}/${receipt?.state ?? 'missing'}`)
}

// 対象last turnの公式task_completeが返答より後に記録済みであること。
export const codexTurnCompleted = (turns, last) => { const ended = turns.get(last.turn_id); return Boolean(ended && ended.end_kind === 'task_complete' && ended.completed_order >= last.order) }
export function codexTurns(file) {
  const turns = new Map(); let current = null
  for (const [order, line] of readFileSync(file, 'utf8').split('\n').slice(0, -1).entries()) {
    const row = JSON.parse(line), value = row.payload ?? {}
    if (row.type === 'turn_context') current = value.turn_id ?? current
    if (row.type !== 'event_msg') continue
    const id = value.turn_id ?? current
    if (!id) continue
    if (['task_started', 'turn_started'].includes(value.type)) { current = id; turns.set(id, { turn_id: id, started_order: order, completed_order: null }) }
    if (['task_complete', 'turn_complete', 'task_interrupted'].includes(value.type)) {
      const saved = turns.get(id) ?? { turn_id: id, started_order: null }
      saved.completed_order = order; saved.end_kind = value.type; turns.set(id, saved)
    }
  }
  return turns
}

export function assertCodexBusy({ workTurn, delivery, record, turns }) {
  const native = turns.get(workTurn)
  if (!workTurn || delivery.turn_id !== workTurn || !['postToolUse', 'post_tool_use', 'post-tool-use', 'PostToolUse', 'stop', 'Stop'].includes(delivery.hook) || record.hook_turn !== workTurn || record.hook_state !== 'output_complete' || !native || native.started_order === null || delivery.order < native.started_order || (native.completed_order !== null && native.completed_order < delivery.order)) fail('ACCEPTANCE_BUSY_CODEX_NATIVE_TURN', '開始した作業と同turnの公式hook配送を確認できません')
  return native
}

// Shellという名前だけでは許可しない。製品が確定した入力と実task/PIDの相関を要求する。
export function nativeReceiveToolAllowed(use, registrations, session) {
  return registrations.some(item => {
    const task = item.native_task
    let output = use.output ?? use.result
    if (typeof output === 'string') { try { output = JSON.parse(output) } catch { return false } }
    const taskId = use.native_task_id ?? output?.task_id ?? output?.shell_id
    const pid = use.native_task_pid ?? output?.pid
    return item.owner_verified === true && item.parent_session === session && (use.session ?? use.parent_session) === session
      && use.name === task.input?.name && isDeepStrictEqual(use.input, task.input?.input)
      && String(taskId ?? '') === task.id && pid === task.pid
      && item.waiter_owner.pid > 0 && item.waiter_owner.started && task.process_identity?.pid === pid && task.process_identity.started
  })
}

// 受信taskの全量readerも受信維持の一部。実task/readの相関がないRead等は許可しない。
export function nativeReceiveReaderAllowed(use, registrations, tasks, session) {
  const read = tasks.find(task => task.reader_tool_use_id === use.id && task.session === session && task.result?.schema === 'peertable.parent-background-result.v1')
  if (!read || (use.session ?? use.parent_session) !== session) return false
  const registration = registrations.find(item => item.owner_verified === true && item.parent_session === session && item.native_task.id === String(read.task_id ?? read.id) && item.endpoint_id === read.result.endpoint_id)
  if (!registration || !registration.native_task.process_identity?.started || !registration.waiter_owner.started) return false
  if (registration.native_task.input?.name === 'Shell') return use.name === 'Read' && use.input?.path === read.output_file && !Object.hasOwn(use.input, 'offset') && !Object.hasOwn(use.input, 'limit')
  return registration.native_task.input?.name === 'run_terminal_command' && use.name === 'get_command_or_subagent_output' && isDeepStrictEqual(use.input, { task_ids: [registration.native_task.id] })
}

// 公式completion hookのCID/generationと対象last replyを照合する。UIのfooterだけでは完了にしない。
export function cursorIdleCompletion(events, last, session) {
  if (!last || last.session !== session || !last.turn_id) fail('ACCEPTANCE_IDLE_NATIVE_END_MISSING', '対象Cursor応答の会話/generationがありません')
  return events.find(row => row.event?.hook_event_name === 'stop' && row.event.status === 'completed' && row.event.conversation_id === session && row.event.generation_id === last.turn_id) ?? null
}

export async function createScenarioContext(options) {
  const { meta, spool, api, observe, submit, file, pkg, projectDir, privateDir, proxy, bin, nativeActions = {}, screen, nativeStopFile } = options
  const importInstalled = name => import(pathToFileURL(join(pkg, 'skill/scripts', name)).href)
  const { PAGE_CHARS } = await importInstalled('parent-delivery.mjs')
  const { sameProcess, processIdentity, processDescendsFrom, shellCommand } = await importInstalled('parent-platform.mjs')
  const recipient = spool.read().name, pending = [], faultState = new Map(), actions = {}, nativeRegistrations = []
  const targets = new Map([['self', { meta, spool, api, observe, submit, file, screen }]])
  const context = { harness: meta.harness, session: meta.parent_session, pageChars: PAGE_CHARS, actions,
    registerEndpoint(name, target) {
      if (!name || !target?.spool || !target.meta?.parent_session || !target.file || typeof target.api !== 'function' || typeof target.observe !== 'function' || typeof target.submit !== 'function') fail('ACCEPTANCE_ENDPOINT_REGISTRATION_INVALID', name)
      if (target.meta.harness !== meta.harness || target.meta.source_commit !== meta.source_commit || target.meta.runtime_digest !== meta.runtime_digest || target.meta.package_version !== meta.package_version) fail('ACCEPTANCE_ENDPOINT_SOURCE_MISMATCH', name)
      targets.set(name, target); return target
    }, endpoint(name = 'self') { const target = targets.get(name); if (!target) fail('ACCEPTANCE_NATIVE_ENDPOINT_ADAPTER_MISSING', name); return target },
  }
  const targetFor = posted => posted?.target_object ?? context.endpoint(posted?.target ?? 'self')
  const anchor = () => { const seen = observe(); return seen.replies.at(-1)?.turn_id ?? seen.toolUses.at(-1)?.turn_id ?? seen.turns.at(-1) }
  const captureNativeRegistrations = () => {
    for (const target of targets.values()) {
      const waiter = target.spool.read().waiter
      if (waiter?.native_task?.id && sameProcess(waiter.owner) && !nativeRegistrations.some(item => item.native_task.id === waiter.native_task.id && item.parent_session === target.meta.parent_session)) nativeRegistrations.push({ parent_session: target.meta.parent_session, endpoint_id: target.spool.id, waiter_owner: waiter.owner, native_task: waiter.native_task, owner_verified: true, observed_at: new Date().toISOString() })
    }
  }
  const artifactFor = (scope, label) => { const dir = join(privateDir, 'scenarios', scope.runId, scope.scenario); mkdirSync(dir, { recursive: true, mode: 0o700 }); return artifactPath(dir, label) }
  const result = (scope, expectation, source, detail = {}) => {
    captureNativeRegistrations()
    const artifact = artifactFor(scope, `${scope.step_index ?? randomUUID()}-${expectation}`)
    const evidence = { kind: expectation, run_id: scope.runId, scenario: scope.scenario, parent_session: meta.parent_session, turn_id: anchor(), source, artifact, ...detail }
    if (!evidence.turn_id) fail('ACCEPTANCE_NATIVE_TURN_MISSING', expectation)
    writeFileSync(artifact, JSON.stringify(evidence, null, 2))
    return { expectation, verified: true, observations: [evidence] }
  }
  const recordFor = posted => targetFor(posted).spool.read().records.find(item => item.event.seq === posted.seq)
  const receiptFor = async posted => { const target = targetFor(posted); return (await target.api(`deliveries?seq=${posted.seq}`)).delivery[target.spool.read().name] }
  const heartbeat = async () => (await api('members')).bridges?.parent_receiver?.endpoints?.find(endpoint => endpoint.endpoint_id === spool.id)?.beat_at
  const check = async (posted, scope) => {
    const target = targetFor(posted), targetMeta = target.meta, targetRecipient = target.spool.read().name
    await until(`${scope.scenario}:${posted.nonce} 実親の返答`, async () => {
      captureNativeRegistrations()
      const record = recordFor(posted), receipt = await receiptFor(posted)
      return record?.state === 'submitted' && receipt?.state === 'delivered' && target.observe().replies.some(reply => reply.session === targetMeta.parent_session && reply.text.includes(posted.nonce))
    }, options.deliveryTimeout ?? 300000)
    const seen = await until('会話末尾確定', () => { const value = target.observe(); return value.pending_tail === 0 ? value : null }, 30000)
    const record = recordFor(posted), receipt = await receiptFor(posted)
    let deliveries = seen.deliveries
    const preview = deliveries.find(item => item.delivery_id === record.delivery_id && item.preview)
    const pages = ['cursor', 'grok'].includes(targetMeta.harness) ? (seen.pages ?? []).filter(item => item.page.delivery_id === record.delivery_id) : nativeReadPages(targetMeta.harness, target.file, record.delivery_id)
    if (preview || pages.length) {
      const assembled = assembleNativePages(pages)
      if (!assembled || pages.some(item => item.page.endpoint_id !== target.spool.id)) fail('ACCEPTANCE_NATIVE_WHOLE_BODY_MISSING', `${scope.scenario}: parent_read最終page/endpointが不一致です`)
      deliveries = [...deliveries.filter(item => item.delivery_id !== record.delivery_id), { ...(preview ?? {}), room: preview?.room ?? target.spool.read().room, from: assembled.first.event.from ?? assembled.first.event.message?.from, to: assembled.first.event.to_names ?? assembled.first.event.to ?? assembled.first.event.message?.to_names ?? assembled.first.event.message?.to, seq: assembled.first.event.seq, body: assembled.body, delivery_id: record.delivery_id, session: targetMeta.parent_session, turn_id: assembled.final.turn_id, order: assembled.final.order, preview: false, boundary: { encoding: 'none', raw_body_equal: true, native_pages: pages.length } }]
    }
    const judged = judgeAudience({ label: posted.label, posted, record, receipt, deliveries, replies: seen.replies, session: targetMeta.parent_session, recipient: targetRecipient })
    copyFileSync(target.file, artifactFor(scope, `${posted.nonce}-transcript.jsonl`))
    return { ...judged, parent_session: targetMeta.parent_session, endpoint_id: target.spool.id, target: posted.target, nonce: posted.nonce, scenario: scope.scenario, run_id: scope.runId, harness: targetMeta.harness }
  }
  const post = async (input, scope) => {
    const target = context.endpoint(input.endpoint ?? 'self'), targetMeta = target.meta
    const posted = { ...(await target.api('messages', { from: 'probe', to: target.spool.read().name, body: input.body })), room: targetMeta.room, nonce: input.nonce, label: input.label, target: input.endpoint ?? 'self', target_object: target }
    pending.push({ posted, scope: { ...scope }, defer: input.defer, allowRetained: input.allowRetained })
    return posted
  }
  actions.deliver = async (input, scope) => {
    captureNativeRegistrations()
    const posted = await post(input, scope), target = targetFor(posted)
    if (input.allowRetained) {
      const outcome = await until('全toolなしの受信または明示再武装待ち', async () => {
        const record = recordFor(posted), receipt = await receiptFor(posted), seen = target.observe(), runtime = target.spool.read().runtime
        if (!record || record.event.body !== posted.body) return null
        if (runtime === 'rearm_pending' && ['ready', 'sending'].includes(record.state) && receipt?.state !== 'delivered') return noToolsReception({ posted, record, receipt, seen, session: target.meta.parent_session, runtime })
        if (record.state === 'submitted' && receipt?.state === 'delivered' && seen.replies.some(reply => reply.session === target.meta.parent_session && reply.text.includes(posted.nonce))) return noToolsReception({ posted, record, receipt, seen, session: target.meta.parent_session, runtime })
        return null
      }, options.deliveryTimeout ?? 300000)
      const value = result(scope, 'native_delivery', outcome.state === 'native_received' ? 'harness_transcript' : 'http_boundary', { no_tools_state: outcome.state, seq: posted.seq, related_session: target.meta.parent_session, related_turn_id: outcome.reply?.turn_id ?? null })
      if (outcome.state === 'native_received') {
        const judged = await check(posted, scope); pending.find(item => item.posted === posted).recovered = true
        return { ...value, checks: [judged] }
      }
      return value
    }
    if (input.defer) {
      if (!['source_reconnect', 'process_recovery', 'session_change'].includes(scope.scenario)) await until('製品の原文保存', () => recordFor(posted)?.event.body === posted.body, 45000)
      return result(scope, 'native_delivery', 'http_boundary', { deferred: true, seq: posted.seq, related_session: target.meta.parent_session, posted_body_sha256: sha256(posted.body), receipt: await receiptFor(posted) })
    }
    const judged = await check(posted, scope)
    if (['busy', 'consecutive'].includes(scope.scenario) && faultState.has(`${scope.runId}:work`) && targetMetaHarness(target) === 'codex') {
      const work = faultState.get(`${scope.runId}:work`)
      const turn = assertCodexBusy({ workTurn: work?.turn, delivery: judged.delivery, record: recordFor(posted), turns: codexTurns(target.file) })
      faultState.get(`${scope.runId}:work`).arrival_turn_state = turn
    }
    return { ...result(scope, 'native_delivery', 'harness_transcript', { seq: posted.seq, delivery_id: judged.delivery?.delivery_id, related_session: target.meta.parent_session, related_turn_id: judged.delivery?.turn_id }), parent_session: target.meta.parent_session, check: judged }
  }
  const targetMetaHarness = target => target.meta.harness
  actions.pending_recover = async (_, scope) => {
    const selected = pending.filter(item => item.scope.runId === scope.runId && item.scope.scenario === scope.scenario && item.defer && !item.recovered)
    if (!selected.length) fail('ACCEPTANCE_PENDING_NATIVE_MISSING', scope.scenario)
    const checks = []
    for (const item of selected) { checks.push(await check(item.posted, scope)); item.recovered = true }
    return { ...result(scope, 'native_delivery', 'harness_transcript', { seqs: checks.map(item => item.original.seq) }), checks }
  }
  if (['claude', 'codex'].includes(meta.harness)) {
    actions.work_start = async (_, scope) => {
      const script = artifactFor(scope, 'work-process.mjs'), identity = artifactFor(scope, 'work-start.json'), release = artifactFor(scope, 'work-release.json'), completed = artifactFor(scope, 'work-completed.json')
      const nonce = `PEERTABLE_WORK_${randomUUID()}`
      writeFileSync(script, `import {writeFileSync,existsSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));while(!existsSync(process.argv[3]))await new Promise(r=>setTimeout(r,100));writeFileSync(process.argv[4],JSON.stringify({pid:process.pid,completed_at:new Date().toISOString()}));console.log(process.argv[5]);\n`)
      const command = shellCommand(process.execPath, [script, identity, release, completed, nonce])
      const before = observe().rows
      faultState.set(`${scope.runId}:work`, { owner: null, identity, release, completed, nonce, before })
      const tool = meta.harness === 'claude' ? 'Bashのrun_in_background=true' : 'exec_commandのyield_time_ms=1000'
      await submit(`作業継続の実機受入です。${tool}で次のcommandを実行してください。試験専用processはroom配送中も待機し、runnerが解除すると終了します。終了後に符号${nonce}を報告してください。Peertable配送の符号を受信したら、この作業を中止せず報告してください。command: ${command}`)
      await until('実親が開始した作業process', () => existsSync(identity), 120000)
      const owner = processIdentity(JSON.parse(readFileSync(identity, 'utf8')).pid)
      if (!owner || !sameProcess(owner) || !processDescendsFrom(owner, meta.parent_process) || existsSync(completed)) fail('ACCEPTANCE_WORK_NATIVE_OWNER', '実親が所有する存命の作業processを確認できません')
      const seen = observe()
      const workUse = seen.toolUses.find(use => use.order >= before && (meta.harness === 'claude' ? /Bash/u : /exec_command/u).test(use.name))
      if (!workUse?.turn_id) fail('ACCEPTANCE_WORK_NATIVE_TOOL', '公式toolの作業開始が実会話にありません')
      faultState.set(`${scope.runId}:work`, { owner, identity, release, completed, nonce, before, turn: workUse.turn_id, started_order: workUse.order })
      return result(scope, 'work_running', 'os_process', { owner, work_artifact: identity, start_transcript_rows: before, work_turn_id: workUse.turn_id, work_tool_use_id: workUse.id })
    }
    actions.work_finish = async (_, scope) => {
      const work = faultState.get(`${scope.runId}:work`), delivery = scope.checks.at(-1)
      if (!work || !sameProcess(work.owner) || existsSync(work.completed) || !delivery || delivery.delivery.order < work.before) fail('ACCEPTANCE_WORK_NOT_CONTINUED', '配送中に元作業を継続していません')
      const held = processIdentity(work.owner.pid)
      if (meta.harness === 'codex') {
        if (!work.arrival_turn_state) fail('ACCEPTANCE_BUSY_CODEX_NATIVE_TURN', '到着時のnative task/turn状態がありません')
        assertCodexBusy({ workTurn: work.turn, delivery: delivery.delivery, record: recordFor({ seq: delivery.original.seq }), turns: codexTurns(file) })
      }
      writeFileSync(work.release, JSON.stringify({ released_at: new Date().toISOString(), delivery_seq: delivery.original.seq }))
      await until('元作業の完了', () => existsSync(work.completed), 10000)
      const reply = await until('作業継続の実親応答', () => observe().replies.find(item => item.text.includes(work.nonce) && item.order > delivery.delivery.order), 120000)
      if (reply.session !== meta.parent_session) fail('ACCEPTANCE_WORK_SESSION_CHANGED', '元作業の完了は別会話です')
      return result(scope, 'work_continued', 'harness_transcript', { live_at_delivery: held, completion_artifact: work.completed, work_start_turn: work.turn, arrival_turn_state: work.arrival_turn_state ?? null, work_reply_turn: reply.turn_id, delivery_turn: delivery.delivery.turn_id })
    }
  }
  actions.idle_wait = async (_, scope) => {
    if (!screen) fail('ACCEPTANCE_IDLE_ADAPTER_MISSING', '実TUIの観測が必要です')
    // joinは製品状態のverifiedが先に立つ。親の最終返答が会話へ確定するまで待ってから基準にする。
    const seen = await until('join後の実最終返答の会話への確定', () => { const value = observe(); return finalReplyConfirmed(value) ? value : null }, 120000, 100)
    let count = seen.replies.length, last = seen.replies.at(-1)
    await until('実親idle', async () => {
      const view = await screen(), current = observe()
      // 待つ間に親が別の最終返答を確定したら、その返答を基準にidleを待ち直す。
      if (finalReplyConfirmed(current) && current.replies.at(-1).order !== last.order) { count = current.replies.length; last = current.replies.at(-1); return null }
      if (meta.harness === 'cursor') {
        if (!nativeStopFile) fail('ACCEPTANCE_IDLE_NATIVE_END_MISSING', 'Cursorの専用stop hook保存先がありません')
        const events = existsSync(nativeStopFile) ? readJsonl(readFileSync(nativeStopFile, 'utf8'), nativeStopFile).rows.map(item => item.row) : []
        const completed = cursorIdleCompletion(events, last, meta.parent_session)
        if (!completed) return null
        if (!completed.owner?.started || completed.owner.pid !== completed.pid) fail('ACCEPTANCE_IDLE_OBSERVER_IDENTITY_MISSING', 'stop observerの起動時identityがありません')
        if (sameProcess(completed.owner)) return null
        faultState.set(`${scope.runId}:idle_stop`, completed)
        return current.replies.length === count && current.replies.at(-1)?.turn_id === last.turn_id && /Add a follow-up/u.test(view)
      }
      if (meta.harness === 'grok') {
        const ended = readJsonl(readFileSync(file, 'utf8'), file).rows.map(item => item.row.params?.update).filter(update => update?.sessionUpdate === 'turn_completed').at(-1)
        if (ended?.prompt_id !== last.turn_id) return null
      }
      const prompt = ['claude', 'grok'].includes(meta.harness) ? /^\s*❯\s/mu : /^\s*›\s/mu
      return prompt.test(view) && current.replies.at(-1)?.order === last.order
    }, 120000, 1000)
    // promptが作業中にも表示される実装があるため、native task終了の記録も必要にする。
    // 返答の表示直後はまだtaskが終わっていない。公式task_completeが記録されるまで待ち、期限内に来なければtyped errorにする。
    if (meta.harness === 'codex') await until('対象last turnのtask_complete', () => codexTurnCompleted(codexTurns(file), last), 120000, 100).catch(error => { if (error.code === 'ACCEPTANCE_TIMEOUT') fail('ACCEPTANCE_IDLE_NATIVE_END_MISSING', '対象last turnのtask_completeを確認できません'); throw error })
    faultState.set(`${scope.runId}:idle`, { turn: last.turn_id, order: last.order, rows: seen.rows })
    return result(scope, 'idle_without_input', 'harness_transcript', { idle_turn: last.turn_id, reply_order: last.order, official_stop: faultState.get(`${scope.runId}:idle_stop`) ?? null })
  }
  actions.idle_observe = async (_, scope) => {
    const before = faultState.get(`${scope.runId}:idle`), latest = scope.checks.at(-1)
    if (!before || !latest || latest.reply.turn_id === before.turn || latest.delivery.order <= before.order) fail('ACCEPTANCE_IDLE_WAKE_MISSING', '待機後にオーナー入力なしで新turnへ起床した記録がありません')
    return result(scope, 'idle_new_turn_without_input', 'harness_transcript', { before_turn: before.turn, wake_turn: latest.reply.turn_id, owner_inputs_sent: 0 })
  }
  actions.sequence_observe = async (_, scope) => {
    if (scope.checks.length < 2 || scope.checks.some((item, index) => index && (item.original.seq <= scope.checks[index - 1].original.seq || item.delivery.order <= scope.checks[index - 1].delivery.order))) fail('ACCEPTANCE_SEQ_ORDER', scope.scenario)
    return result(scope, 'seq_order', 'harness_transcript', { sequences: scope.checks.map(item => ({ seq: item.original.seq, order: item.delivery.order, turn: item.delivery.turn_id })) })
  }
  actions.policy_set = async (input, scope) => {
    const nonce = `PEERTABLE_POLICY_${randomUUID()}`
    const instruction = input.tools === 'none' ? '以後は全toolを使わず、room配送を受けたら符号を報告してください。' : input.tools === 'parent_only' ? '以後の外部作業toolは使わず、Peertableの受信登録・parent_readだけを許可します。' : '以後は必要な公式toolを使用してよいです。Peertableの受信を継続してください。'
    await submit(`${instruction} 指示を受け取ったら ${nonce} とだけ返答してください。`)
    const reply = await until('tool条件の実親確認', () => observe().replies.find(item => item.text.includes(nonce)))
    faultState.set(`${scope.runId}:policy:${input.tools}`, { order: reply.order, turn: reply.turn_id, tool_count: observe().toolUses.length })
    return result(scope, 'policy_installed', 'harness_transcript', { policy: input.tools, reply_order: reply.order, policy_turn: reply.turn_id })
  }
  actions.tools_observe = async (_, scope) => {
    const mode = scope.scenario === 'no_tools' ? 'none' : 'parent_only', before = faultState.get(`${scope.runId}:policy:${mode}`)
    const used = observe().toolUses.filter(item => item.order > before.order && item.name !== 'output')
    if (mode === 'none' ? used.length : used.some(item => !/parent_(?:join|read|leave)/u.test(item.name) && !nativeReceiveToolAllowed(item, nativeRegistrations, meta.parent_session) && !nativeReceiveReaderAllowed(item, nativeRegistrations, observe().tasks ?? [], meta.parent_session))) fail('ACCEPTANCE_TOOL_POLICY_VIOLATED', JSON.stringify(used.map(item => item.name)))
    const noTools = mode === 'none' ? await Promise.all(pending.filter(item => item.scope.runId === scope.runId && item.allowRetained).map(async item => { const target = targetFor(item.posted); return noToolsReception({ posted: item.posted, record: recordFor(item.posted), receipt: await receiptFor(item.posted), seen: target.observe(), session: target.meta.parent_session, runtime: target.spool.read().runtime }) })) : []
    return result(scope, mode === 'none' ? 'no_tools_or_explicit_rearm' : 'no_external_tools', 'harness_transcript', { tools: used, native_registrations: nativeRegistrations, runtime: spool.read().runtime, no_tools_states: noTools.map(item => item.state) })
  }
  actions.retained_recover = async (_, scope) => {
    const selected = pending.filter(item => item.scope.runId === scope.runId && item.allowRetained && !item.recovered)
    const checks = []
    for (const item of selected) { checks.push(await check(item.posted, scope)); item.recovered = true }
    return { ...result(scope, 'retained_native_recovery', 'harness_transcript', { already_received: selected.length === 0 }), checks }
  }
  actions.receiving_observe = async (_, scope) => {
    if (scope.checks.length < 2 || scope.checks.at(-1).reply.turn_id === scope.checks[0].reply.turn_id) fail('ACCEPTANCE_RECEIVING_NOT_MAINTAINED', '2通目のidle起床がありません')
    const current = spool.read()
    if (['cursor', 'grok'].includes(meta.harness)) await until('2通目後のnative受信再武装', () => { const state = spool.read(); return state.runtime === 'armed' && state.waiter?.native_task?.id && sameProcess(state.waiter.owner) }, 120000)
    else if (!sameProcess(current.watcher) || !['armed', 'rearm_pending'].includes(current.runtime)) fail('ACCEPTANCE_RECEIVING_NOT_MAINTAINED', current.runtime)
    return result(scope, 'native_receiving_maintained', 'harness_transcript', { reply_turns: scope.checks.map(item => item.reply.turn_id), runtime: spool.read().runtime, waiter: spool.read().waiter, watcher: spool.read().watcher })
  }
  actions.pages_observe = async (_, scope) => {
    if (!scope.checks.some(item => item.original.body.length > PAGE_CHARS) || scope.checks.some(item => item.body_equal !== true)) fail('ACCEPTANCE_WHOLE_BODY_MISSING', scope.scenario)
    return result(scope, 'whole_body_recovered', 'harness_transcript', { lengths: scope.checks.map(item => item.original.body.length) })
  }
  actions.burst_start = async (input, scope) => {
    const posted = []
    for (let index = 0; index < input.count; index++) {
      const nonce = `PEERTABLE_BURST_${index}_${randomUUID()}`, body = `日本語\n${'長文 & < > 字面&gt; 😀\n'.repeat(Math.ceil(PAGE_CHARS / 12) * 2)}\n${nonce}`
      posted.push(await post({ label: `burst-${index}`, nonce, body, defer: true }, scope))
    }
    if (posted.reduce((sum, item) => sum + item.body.length, 0) <= PAGE_CHARS) fail('ACCEPTANCE_BURST_LIMIT_NOT_EXCEEDED', scope.scenario)
    faultState.set(`${scope.runId}:burst`, posted)
    return result(scope, 'burst_above_page_limit', 'http_boundary', { seqs: posted.map(item => item.seq), characters: posted.reduce((sum, item) => sum + item.body.length, 0), page_limit: PAGE_CHARS })
  }
  actions.burst_observe = async (_, scope) => {
    const posted = faultState.get(`${scope.runId}:burst`)
    const pagesOf = deliveryId => ['cursor', 'grok'].includes(meta.harness) ? (observe().pages ?? []).filter(item => item.page.delivery_id === deliveryId) : nativeReadPages(meta.harness, file, deliveryId)
    // 未読保持のspoolと実中間pageは同時に揃うまで待つ。spool更新の方がtranscript記録より先に起きる。
    const observed = await until('未読保持のspoolと実tool途中pageの同時観測', () => {
      for (const item of posted) {
        const sample = recordFor(item), pages = sample ? pagesOf(sample.delivery_id) : []
        const matched = intermediatePageMatch(sample, pages), again = sample && recordFor(item)
        if (matched && again.state === 'sending' && again.claim.offset === sample.claim.offset && again.receipt === null) return { sample, pages }
      }
      return null
    }, 120000, 50).catch(error => { if (error.code === 'ACCEPTANCE_TIMEOUT') fail('ACCEPTANCE_BURST_INTERMEDIATE_PAGE_MISSING', '未読状態に相関する実tool途中pageがありません'); throw error })
    const { sample, pages } = observed
    return result(scope, 'unread_until_last_page', 'harness_transcript', { delivery_id: sample.delivery_id, offset: sample.claim.offset, receipt: sample.receipt, native_page_count: pages.length })
  }
  actions.burst_finish = async (_, scope) => {
    const checks = []
    for (const posted of faultState.get(`${scope.runId}:burst`)) checks.push(await check(posted, scope))
    return { ...result(scope, 'burst_seq_whole_body', 'harness_transcript'), checks }
  }
  if (proxy) {
    actions.source_disconnect = async (_, scope) => {
      const before = proxy.events.length, disconnected = proxy.disconnectSource()
      faultState.set(`${scope.runId}:source`, { before, disconnected })
      // 実watcherのSSEが開いている場合は切断を直接観測できる。開いていなければ次の実HTTP失敗を待つ。
      if (!disconnected.interrupted) await until('watcherのHTTP失敗', () => proxy.events.slice(before).some(row => row.kind === 'source_http_failed'), 45000)
      return result(scope, 'http_sse_disconnected', 'http_boundary', { proxy_artifact: proxy.artifact, disconnected })
    }
    actions.source_reconnect = async (_, scope) => {
      const before = proxy.events.length; proxy.reconnectSource()
      await until('source catch-up', () => proxy.events.slice(before).some(row => row.kind === 'request' && row.source), 45000)
      return result(scope, 'http_sse_catchup', 'http_boundary', { proxy_artifact: proxy.artifact, request_events: proxy.events.slice(before) })
    }
    actions.receipt_fail_arm = async (_, scope) => { faultState.set(`${scope.runId}:receipt`, { before: proxy.events.length }); proxy.failReceipts(); return result(scope, 'own_receipt_http_failure', 'http_boundary', { proxy_artifact: proxy.artifact }) }
    actions.receipt_failure_observe = async (_, scope) => {
      const selected = pending.filter(item => item.scope.runId === scope.runId && item.defer).at(-1)
      const sample = await until('本文出力後receipt失敗', () => { const saved = recordFor(selected.posted); return saved?.state === 'submitted' && saved.receipt?.pending && observe().replies.some(reply => reply.text.includes(selected.posted.nonce)) ? saved : null })
      const failures = proxy.events.slice(faultState.get(`${scope.runId}:receipt`).before).filter(row => row.kind === 'receipt_http_failed')
      if (!failures.length) fail('ACCEPTANCE_RECEIPT_BOUNDARY_FAILURE_MISSING', scope.scenario)
      faultState.get(`${scope.runId}:receipt`).sample = sample
      return result(scope, 'native_output_receipt_pending', 'harness_transcript', { delivery_id: sample.delivery_id, receipt_revision: sample.receipt.receipt_revision, failure_count: failures.length, proxy_artifact: proxy.artifact })
    }
    actions.receipt_restore = async (_, scope) => {
      proxy.restoreReceipts(); const before = faultState.get(`${scope.runId}:receipt`).sample
      await until('receiptだけ復旧', () => { const item = spool.read().records.find(record => record.delivery_id === before.delivery_id); return item.receipt?.pending === false && item.receipt.receipt_revision === before.receipt.receipt_revision })
      return result(scope, 'receipt_only_recovered', 'http_boundary', { proxy_artifact: proxy.artifact, receipt_revision: before.receipt.receipt_revision })
    }
    actions.receipt_retry_observe = async (_, scope) => {
      const check = scope.checks.at(-1), before = faultState.get(`${scope.runId}:receipt`).sample
      if (check.count !== 1 || check.receipt.receipt_revision !== before.receipt.receipt_revision || recordFor({ seq: check.original.seq }).claim.id !== before.claim.id) fail('ACCEPTANCE_RECEIPT_BODY_RESENT', scope.scenario)
      return result(scope, 'output_once_receipt_revision', 'harness_transcript', { delivery_id: before.delivery_id, claim_id: before.claim.id, revision: check.receipt.receipt_revision })
    }
  }
  actions.watcher_stop = async (_, scope) => {
    const saved = spool.read(), owner = saved.watcher
    if (!owner || !sameProcess(owner) || owner.pid === meta.parent_process.pid || !processDescendsFrom(owner, meta.parent_process)) fail('ACCEPTANCE_FIXTURE_PROCESS_OWNER', '試験親のwatcher所有を確認できません')
    process.kill(owner.pid, 'SIGTERM'); await until('watcher終了', () => !sameProcess(owner), 10000, 100)
    faultState.set(`${scope.runId}:watcher`, { owner, cursor: saved.cursor, runtime: saved.runtime })
    return result(scope, 'own_watcher_stopped', 'os_process', { owner, cursor: saved.cursor })
  }
  actions.watcher_rejoin = async (_, scope) => {
    const before = faultState.get(`${scope.runId}:watcher`), retained = pending.filter(item => item.scope.runId === scope.runId && item.defer)
    const records = retained.map(item => recordFor(item.posted))
    // 製品の正規watch開始を親の同joinから行う。runnerから擬似親watcherを起動しない。
    await submit(`Peertable parent_joinをproject=${projectDir} name=${recipient}で同じ会話から一度だけ呼び、既存受信を再開してください。配送確認の符号を正確に報告してください。`)
    const current = await until('製品watcher再起動', () => { const saved = spool.read(); return saved.watcher && saved.watcher.pid !== before.owner.pid && sameProcess(saved.watcher) ? saved : null })
    if (current.endpoint_id !== spool.id || current.cursor < before.cursor || current.caller.conversation !== meta.parent_session) fail('ACCEPTANCE_READY_RECOVERY_IDENTITY', '同じendpoint/cursor/親会話を継承しませんでした')
    return result(scope, 'own_watcher_restarted', 'os_process', { before_owner: before.owner, new_owner: current.watcher, before_cursor: before.cursor, cursor: current.cursor, retained: records.map(item => ({ delivery_id: item?.delivery_id ?? null, state: item?.state ?? null })) })
  }
  const armInterruption = (scope, { afterDelete = false, includeWatcher = false } = {}) => {
    const baseline = new Set(spool.read().records.map(record => record.delivery_id))
    const monitor = { completed: false, canceled: false, interrupted: null, error: null }
    monitor.promise = (async () => {
      const deadline = Date.now() + 120000
      while (!monitor.canceled && Date.now() < deadline) {
        const record = spool.read().records.find(item => !baseline.has(item.delivery_id) && item.state === 'sending' && (!afterDelete || item.hook_state === 'deleted'))
        if (record) {
          const owner = record.hook_claim?.owner ?? record.claim?.owner
          const watcher = spool.read().watcher
          if (owner && owner.pid !== meta.parent_process.pid && (includeWatcher || owner.pid !== watcher?.pid) && sameProcess(owner) && processDescendsFrom(owner, meta.parent_process)) {
            const now = spool.read().records.find(item => item.delivery_id === record.delivery_id)
            if (now.state !== 'sending' || (afterDelete && now.hook_state !== 'deleted')) { await sleep(1); continue }
            const at = new Date().toISOString()
            process.kill(owner.pid, 'SIGKILL')
            monitor.interrupted = { record: now, owner, at, after_delete: afterDelete }
            monitor.completed = true
            return monitor.interrupted
          }
        }
        await sleep(1)
      }
      if (!monitor.canceled) monitor.error = Object.assign(new Error('実claimの中断可能な区間を観測できませんでした'), { code: 'ACCEPTANCE_CLAIM_BOUNDARY_MISSED' })
      monitor.completed = true
      return null
    })().catch(error => { monitor.error = error; monitor.completed = true; return null })
    faultState.set(`${scope.runId}:interrupt`, monitor)
    return monitor
  }
  actions.output_interrupt_arm = async (_, scope) => {
    if (meta.harness === 'codex') {
      // delete後の出力を観測するので、nativeの同期hookを通った場合だけfaultが成立する。
      // idle queueだけで完了した場合はboundary_missedで止める。
      armInterruption(scope, { afterDelete: true })
    } else armInterruption(scope)
    return result(scope, 'own_output_boundary_armed', 'os_process', { endpoint_id: spool.id, target_parent: meta.parent_process, codex_after_delete: meta.harness === 'codex' })
  }
  actions.output_interrupt = async (_, scope) => {
    const monitor = faultState.get(`${scope.runId}:interrupt`)
    await until('実出力processの中断', () => monitor.completed, 125000, 10)
    if (monitor.error) throw monitor.error
    if (!monitor.interrupted) fail('ACCEPTANCE_CLAIM_BOUNDARY_MISSED', scope.scenario)
    const interrupted = monitor.interrupted
    await until('中断後unknown receipt', async () => {
      const record = spool.read().records.find(item => item.delivery_id === interrupted.record.delivery_id)
      const receipt = await receiptFor({ seq: record.event.seq })
      return record.state === 'unknown' && record.event.body === interrupted.record.event.body && receipt?.state === 'unknown'
    }, 45000)
    const record = spool.read().records.find(item => item.delivery_id === interrupted.record.delivery_id)
    faultState.set(`${scope.runId}:unknown`, { record, at_rows: observe().rows })
    return result(scope, 'claim_output_unknown_preserved', 'os_process', { interrupted_owner: interrupted.owner, killed_at: interrupted.at, delivery_id: record.delivery_id, body_sha256: sha256(record.event.body), error_code: record.error_code, receipt_revision: record.receipt.receipt_revision, after_delete: interrupted.after_delete })
  }
  actions.output_unknown_observe = async (_, scope) => {
    const before = faultState.get(`${scope.runId}:unknown`), initial = before.record
    // sourceの次のhealth/receipt周期を跨ぎ、実会話への自動再送が無いことを確認する。
    // 初回unknownの記録だけで再送なしを断定しない。
    const initialSource = await heartbeat()
    if (!initialSource) fail('ACCEPTANCE_SOURCE_HEARTBEAT_MISSING', scope.scenario)
    const nextSource = await until('unknown後の製品維持周期', async () => { const at = await heartbeat(); return at && at > initialSource ? at : null }, 60000)
    const record = spool.read().records.find(item => item.delivery_id === initial.delivery_id), seen = observe()
    if (record.state !== 'unknown' || record.event.body !== initial.event.body || record.claim.id !== initial.claim.id || record.receipt.receipt_revision !== initial.receipt.receipt_revision || seen.deliveries.some(item => item.delivery_id === initial.delivery_id && item.order >= before.at_rows)) fail('ACCEPTANCE_UNKNOWN_RESENT_OR_LOST', scope.scenario)
    return result(scope, 'unknown_not_resent', 'harness_transcript', { delivery_id: record.delivery_id, initial_source_progress: initialSource, next_source_progress: nextSource, observed_rows: seen.rows, initial_rows: before.at_rows, body_sha256: sha256(record.event.body), receipt_revision: record.receipt.receipt_revision })
  }
  actions.sending_interrupt = async (_, scope) => {
    const nonce = `PEERTABLE_SENDING_INTERRUPT_${randomUUID()}`
    const monitor = armInterruption(scope, { includeWatcher: true })
    await post({ label: 'sending中断', nonce, body: `日本語 sending原文\n${nonce}`, defer: true }, scope)
    await until('実sending processの中断', () => monitor.completed, 125000, 10)
    if (monitor.error) throw monitor.error
    if (monitor.interrupted?.owner.pid === spool.read().watcher?.pid) {
      await submit(`同じPeertable parent_joinをproject=${projectDir} name=${recipient}で一度だけ呼び、実watcherの孤児claim回収を継続してください。`)
      await until('中断後の実watcher再起動', () => { const owner = spool.read().watcher; return owner && owner.pid !== monitor.interrupted.owner.pid && sameProcess(owner) })
    }
    await actions.output_interrupt({}, scope)
    await actions.output_unknown_observe({}, scope)
    return result(scope, 'sending_unknown_no_resend', 'harness_transcript', { interrupted: monitor.interrupted, receipt: await receiptFor({ seq: monitor.interrupted.record.event.seq }) })
  }
  actions.submitted_restart = async (_, scope) => {
    const submitted = scope.checks.at(-1)
    if (!submitted) fail('ACCEPTANCE_SUBMITTED_BASELINE_MISSING', scope.scenario)
    const record = recordFor({ seq: submitted.original.seq }), before = { claim: record.claim.id, receipt: record.receipt.receipt_revision, count: observe().deliveries.filter(item => item.delivery_id === record.delivery_id).length }
    const owner = spool.read().watcher
    if (owner && sameProcess(owner)) {
      if (owner.pid === meta.parent_process.pid || !processDescendsFrom(owner, meta.parent_process)) fail('ACCEPTANCE_FIXTURE_PROCESS_OWNER', 'watcherの所有が不一致です')
      process.kill(owner.pid, 'SIGTERM'); await until('watcher停止', () => !sameProcess(owner), 10000, 100)
    }
    await submit(`同じPeertable parent_joinをproject=${projectDir} name=${recipient}で一度だけ呼び、既存受信を継続してください。`)
    await until('watcher再起動', () => { const current = spool.read().watcher; return current && sameProcess(current) && current.pid !== owner?.pid })
    const firstBeat = await heartbeat()
    await until('再起動後の製品維持周期', async () => { const at = await heartbeat(); return at && at > firstBeat }, 60000)
    const after = recordFor({ seq: submitted.original.seq }), count = observe().deliveries.filter(item => item.delivery_id === record.delivery_id).length
    if (after.state !== 'submitted' || after.claim.id !== before.claim || after.receipt.receipt_revision !== before.receipt || count !== before.count) fail('ACCEPTANCE_SUBMITTED_RESENT', scope.scenario)
    return result(scope, 'submitted_not_resubmitted', 'harness_transcript', { delivery_id: record.delivery_id, before, after_count: count, new_watcher: spool.read().watcher })
  }
  actions.package_inspect = async (_, scope) => {
    const state = spool.read(), paths = [state.watcher?.executable, ...(state.wait_receipt?.args ?? [])].filter(Boolean)
    if (meta.package_version !== JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version || !meta.package_tarball_sha256 || paths.some(path => path.includes('/Developer/peertable/') || path.includes('/worktrees/'))) fail('ACCEPTANCE_PACKAGE_CHECKOUT_DEPENDENCY', '配布物の版・tarball・実receiver pathが不一致です')
    const watcher = state.watcher && processIdentity(state.watcher.pid)
    if (!watcher?.command.includes(join(pkg, 'skill/scripts/parent-watch.mjs'))) fail('ACCEPTANCE_PACKAGE_NATIVE_ENTRY_MISSING', '実watcherが導入物のentryを使用していません')
    return result(scope, 'pack_installed_no_checkout_paths', 'installed_package', { tarball_sha256: meta.package_tarball_sha256, version: meta.package_version, runtime_digest: meta.runtime_digest, native_watcher: watcher, installed_root: pkg })
  }
  actions.package_observe = async (_, scope) => {
    if (!scope.checks.length || scope.checks.at(-1).status !== 'passed') fail('ACCEPTANCE_PACKAGE_NATIVE_DELIVERY_MISSING', scope.scenario)
    return result(scope, 'pack_native_entry_used', 'harness_transcript', { installed_root: pkg, endpoint_id: spool.id })
  }
  // 専用のnative adapterは親の所有を検証して操作し、その実artifactを返す。
  // callbackが無い境界はrunScenarioが事前にtyped errorで停止する。
  for (const [name, action] of Object.entries(nativeActions)) {
    if (actions[name]) fail('ACCEPTANCE_ACTION_OVERRIDE', `既存の実操作を上書きできません: ${name}`)
    actions[name] = (input, scope) => action(input, { ...scope, meta, spool, api, observe, submit, file, pkg, projectDir, privateDir, result, pending, check, post, faultState, context, targetFor, recordFor, receiptFor, heartbeat, artifactFor, until, sameProcess, processIdentity, processDescendsFrom, shellCommand })
  }
  context.finalize = async scope => {
    const monitor = faultState.get(`${scope.runId}:interrupt`)
    if (monitor) { monitor.canceled = true; await monitor.promise }
    const work = faultState.get(`${scope.runId}:work`)
    if (work) {
      // releaseはこの試験が作ったprocessだけが読む。startに失敗しても後発のchildを待機させない。
      writeFileSync(work.release, JSON.stringify({ released_at: new Date().toISOString(), cleanup: true }))
      if (work.owner && sameProcess(work.owner)) {
        try { await until('試験作業processの後片付け', () => !sameProcess(work.owner), 10000, 100) }
        catch (error) { if (error.code !== 'ACCEPTANCE_TIMEOUT') throw error; if (sameProcess(work.owner)) process.kill(work.owner.pid, 'SIGKILL'); await until('強制終了後の試験process消失', () => !sameProcess(work.owner), 10000, 100) }
      }
    }
  }
  context.supported = scenarioNames.filter(name => scenarioPlan(name, { pageChars: PAGE_CHARS }).every(item => typeof actions[item.action] === 'function'))
  context.missing = Object.fromEntries(scenarioNames.filter(name => !context.supported.includes(name)).map(name => [name, [...new Set(scenarioPlan(name, { pageChars: PAGE_CHARS }).map(item => item.action))].filter(action => !actions[action])]))
  return context
}
