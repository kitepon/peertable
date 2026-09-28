// 公式receiver準備と、専用watcherが生成した最初のqueue接続を原RPC/OS identityで照合する。
import { readFileSync, appendFileSync, writeFileSync, existsSync, realpathSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import cp from 'node:child_process'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const sameIdentity = (a, b) => a && b && a.pid === b.pid && a.started === b.started
// 既存期限timerの実process focusedと同じ観測上限。製品の30秒期限を変更しない。
export const QUEUE_PROBE_OBSERVATION_LIMIT_MS = 1500

// Codex公式itemのMCP結果を読む。execの自由文出力やモデルの報告を結果へ代用しない。
export function codexProbeJoinBoundary({ file, session, project, name, endpointId, after = -1 }) {
  const lines = readFileSync(file, 'utf8').split('\n'); lines.pop()
  let actualSession = null
  for (const [order, line] of lines.entries()) {
    let row
    try { row = JSON.parse(line) } catch { fail('ACCEPTANCE_TRANSCRIPT_CORRUPT', '自己Codexの確定transcript行がJSONではありません') }
    if (row.type === 'session_meta') actualSession = row.payload.id
    const payload = row.payload, item = payload?.item, value = item?.result?.structuredContent
    if (order > after && actualSession === session && row.type === 'event_msg' && payload.type === 'item_completed' && payload.thread_id === session && payload.turn_id && item?.type === 'McpToolCall' && item.server === 'peertable_parent' && item.tool === 'parent_join' && item.status === 'completed' && item.arguments?.project === project && item.arguments?.name === name && value?.schema === 'peertable.parent-join-result.v1' && value.endpoint_id === endpointId && ['receiving', 'verified'].includes(value.state)) return { order, timestamp: row.timestamp, session, turn_id: payload.turn_id, native_tool_use_id: item.id, raw: row, result: value }
  }
  return null
}

// chunk分割を保持した原logから、改行で確定した公式JSON-RPCだけを復元する。
export function queueFaultRpcRows(events) {
  const buffers = new Map(), rows = []
  for (const event of events) {
    if (!['rpc_write_raw', 'rpc_read_raw'].includes(event.kind)) continue
    const key = `${event.pid}:${event.child_pid}:${event.kind}`, text = (buffers.get(key) ?? '') + event.raw
    const lines = text.split('\n'); buffers.set(key, lines.pop())
    for (const line of lines) {
      let row
      try { row = JSON.parse(line) } catch { fail('ACCEPTANCE_QUEUE_FAULT_RPC_CORRUPT', '公式RPCの確定行がJSONではありません') }
      rows.push({ ...event, row })
    }
  }
  return rows
}

export function queueProbeReceiverProof({ events, pause, expectedCommand, expectedSource }) {
  const rows = queueFaultRpcRows(events), connections = events.filter(event => event.kind === 'official_connection_spawn' && event.pid !== pause.watcher.pid && event.at < pause.paused_at && event.executable === pause.executable && JSON.stringify(event.spawn_argv) === JSON.stringify(['app-server', '--listen', 'stdio://']))
  for (const connection of connections) {
    const own = rows.filter(row => row.child_pid === connection.child_pid && row.pid === connection.pid)
    const call = method => own.find(row => row.kind === 'rpc_write_raw' && row.row.method === method)
    const result = request => request && own.find(row => row.kind === 'rpc_read_raw' && row.row.id === request.row.id && row.row.result && row.at < pause.paused_at)
    const initialize = call('initialize'), thread = call('thread/read'), queue = call('thread/queue/list'), hooks = call('hooks/list')
    const hookResult = result(hooks), entries = hookResult?.row.result.data?.flatMap(group => group.hooks ?? []) ?? []
    const owned = entries.filter(hook => hook.command === expectedCommand && hook.sourcePath === expectedSource && hook.handlerType === 'command' && hook.async === false)
    const actualThread = result(thread)?.row.result.thread
    const subagent = actualThread?.source?.subAgent
    if (!result(initialize) || !thread || thread.row.params.threadId !== pause.caller.conversation || thread.row.params.includeTurns !== false || actualThread?.id !== pause.caller.conversation || subagent && typeof subagent === 'object' && 'thread_spawn' in subagent || !queue || queue.row.params.threadId !== pause.caller.conversation || queue.row.params.limit !== 1 || !result(queue) || !hooks?.row.params.cwds.includes(pause.project) || owned.length !== 2 || !['postToolUse', 'stop'].every(event => owned.some(hook => hook.eventName === event && hook.enabled === true && hook.trustStatus === 'trusted'))) continue
    const watcherRequests = rows.filter(row => row.pid === pause.watcher.pid && row.child_pid === pause.owner.pid && row.kind === 'rpc_write_raw')
    if (!watcherRequests.some(row => row.row.method === 'initialize') || watcherRequests.some(row => row.row.method === 'thread/queue/add')) fail('ACCEPTANCE_QUEUE_PROBE_FAULT_STAGE', '初回probe受付前の公式接続停止ではありません')
    return { connection, initialize: result(initialize), thread: result(thread), queue: result(queue), hooks: hookResult, owned_hooks: owned, stopped_before_queue_add: true }
  }
  fail('ACCEPTANCE_QUEUE_RECEIVER_CHECK_MISSING', '故障前に公式receiver本人/queue/hooks検証が成功した原RPCがありません')
}

// atomic renameでも同じspoolを追う。読取のみで実期限/failedの初回観測時刻を保存する。
export function watchQueueProbeState({ spool, artifact }) {
  const observer = { rows: [], error: null, closed: false }
  const capture = trigger => {
    try {
      const raw = readFileSync(spool.file), state = JSON.parse(raw)
      const row = { at: new Date().toISOString(), trigger, raw: raw.toString('utf8'), state }
      observer.rows.push(row)
      appendFileSync(artifact, JSON.stringify(row) + '\n', { mode: 0o600 })
    } catch (error) { observer.error = error }
  }
  const watcher = watch(dirname(spool.file), (_, filename) => { if (!filename || String(filename) === 'spool.json') capture('fs.watch') })
  watcher.on('error', error => { observer.error = error })
  capture('start')
  observer.close = () => { if (!observer.closed) { observer.closed = true; watcher.close() } }
  return observer
}

// 製品の実deadlineと、controllerがfailedを観測するまでの上限を別々に残す。
export function queueProbeTimeoutProof({ pause, observations, health }) {
  const deadline = pause.spool_before.probe_deadline
  if (!Number.isFinite(deadline)) fail('ACCEPTANCE_QUEUE_PROBE_DEADLINE_MISSING', '実probe_deadlineがありません')
  const failed = observations.find(row => row.state.endpoint_id === pause.endpoint_id && row.state.state === 'failed' && row.state.runtime === 'failed' && row.state.error_code === 'PARENT_PROBE_TIMEOUT')
  const endpoint = health.bridges?.parent_receiver?.endpoints?.find(item => item.endpoint_id === pause.endpoint_id)
  let detail
  try { detail = typeof endpoint?.detail === 'string' ? JSON.parse(endpoint.detail) : endpoint?.detail } catch { fail('ACCEPTANCE_QUEUE_HEALTH_DETAIL_CORRUPT', '公式GETmembersのdetailがJSONではありません') }
  if (!failed || endpoint?.state !== 'failed' || detail?.endpoint_id !== pause.endpoint_id || detail.state !== 'failed' || detail.error_code !== 'PARENT_PROBE_TIMEOUT') fail('ACCEPTANCE_QUEUE_PROBE_TIMEOUT_NOT_OBSERVED', 'own endpointの実spoolとGETmembersに同じ期限failureがありません')
  const observationLag = Date.parse(failed.at) - deadline, healthLag = Date.parse(endpoint.beat_at) - deadline
  const measurement = { probe_deadline: deadline, first_failed_at: failed.at, failed_observation_lag_ms: observationLag, failed_health_beat_at: endpoint.beat_at, failed_health_lag_ms: healthLag, failed_state: failed.state, health_endpoint: endpoint, max_observation_lag_ms: QUEUE_PROBE_OBSERVATION_LIMIT_MS }
  if (!Number.isFinite(observationLag) || !Number.isFinite(healthLag)) throw Object.assign(new Error('実probe failureの時刻がありません'), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_TIME_MISSING', detail: measurement })
  if (observationLag < 0 || healthLag < 0) throw Object.assign(new Error('実probe deadlineより前にfailureを観測しました'), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_EARLY', detail: measurement })
  if (observationLag > QUEUE_PROBE_OBSERVATION_LIMIT_MS || healthLag > QUEUE_PROBE_OBSERVATION_LIMIT_MS) throw Object.assign(new Error('実probe failureはcontrollerの観測上限を超えました'), { code: 'ACCEPTANCE_QUEUE_PROBE_TIMEOUT_LATE', detail: measurement })
  return measurement
}

export async function installQueueProbeFault(fixture, options) { return installQueueObserver(fixture, { ...options, pauseProbe: true }) }
export async function installQueueConnectionObserver(fixture, options) { return installQueueObserver(fixture, { ...options, pauseProbe: false }) }

async function installQueueObserver(fixture, { pkg, artifact, holdMs = 35000, pauseProbe }) {
  if (fixture.harness !== 'codex' || fixture.pty) fail('ACCEPTANCE_QUEUE_FAULT_PREPARATION_ORDER', '専用Codex起動前だけにOS故障observerを準備します')
  if (pauseProbe && process.platform === 'win32') fail('ACCEPTANCE_QUEUE_FAULT_OS_API_UNCONFIRMED', 'Windowsの所有childを停止/再開する公式OS APIはまだ実測していません')
  const configFile = artifact('probe-fault-config'), logFile = artifact('probe-rpc-os.jsonl'), pauseFile = artifact('probe-suspended'), terminalFile = artifact('probe-terminal'), disarmedFile = artifact('probe-fault-disarmed')
  const config = { pkg, project: fixture.project, hold_ms: holdMs, pause_probe: pauseProbe, log_file: logFile, pause_file: pauseFile, terminal_file: terminalFile, disarmed_file: disarmedFile }
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 })
  fixture.processEnvironment = { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fileURLToPath(import.meta.url)).href}`].filter(Boolean).join(' '), PEERTABLE_ACCEPTANCE_QUEUE_PROBE: configFile }
  const platform = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-platform.mjs')).href)
  return {
    config_file: configFile, log_file: logFile, pause_file: pauseFile, terminal_file: terminalFile,
    events: () => existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [],
    pause: () => existsSync(pauseFile) ? JSON.parse(readFileSync(pauseFile, 'utf8')) : null,
    terminal: () => existsSync(terminalFile) ? JSON.parse(readFileSync(terminalFile, 'utf8')) : null,
    async close() {
      // 自分のobserver制御だけを解除する。製品の時計/state/RPCは変更しない。
      writeFileSync(disarmedFile, '{}', { mode: 0o600 })
      const paused = this.pause()
      if (paused && platform.sameProcess(paused.owner)) {
        process.kill(paused.owner.pid, 'SIGCONT')
        appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), kind: 'finalize_own_sigcont', owner: paused.owner }) + '\n')
      }
      delete fixture.processEnvironment
    },
  }
}

// samplingを使わず、実spawn/queue応答/closeを同じ接続とspool claimへ結ぶ。
export function observedQueueConnections({ events, watcher, endpointId, session }) {
  const rpc = queueFaultRpcRows(events)
  return events.filter(event => event.kind === 'official_connection_spawn' && event.owned_queue && sameIdentity(event.queue_owner, watcher) && event.endpoint_id === endpointId && event.session === session && event.child_owner?.started).map(event => {
    const closed = events.find(row => row.kind === 'official_connection_closed' && row.pid === event.pid && sameIdentity(row.child_owner, event.child_owner) && row.at >= event.at)
    const requests = rpc.filter(row => row.pid === event.pid && row.child_pid === event.child_pid && row.kind === 'rpc_write_raw' && row.row.method === 'thread/queue/add' && row.row.params?.threadId === session && row.row.params.clientUserMessageId === event.queue_record.delivery_id)
    const accepted = requests.flatMap(request => rpc.filter(row => row.pid === event.pid && row.child_pid === event.child_pid && row.kind === 'rpc_read_raw' && row.row.id === request.row.id && row.row.result?.queuedSubmission?.id).map(response => ({ request, response, queued_submission_id: response.row.result.queuedSubmission.id })))
    return { owner: event.child_owner, watcher: event.queue_owner, endpoint_id: endpointId, session, delivery_id: event.queue_record.delivery_id, first_seen_at: event.at, closed_at: closed?.at ?? null, close_identity_alive: closed?.child_identity_alive ?? null, accepted, source: 'official_spawn_rpc_close', raw_spawn: event, raw_close: closed ?? null }
  })
}

// --importは自己projectの子だけに継承する。spawn/RPCの引数・戻り値・callbackは一切変更しない。
const configPath = process.env.PEERTABLE_ACCEPTANCE_QUEUE_PROBE
if (configPath && existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (process.cwd() === config.project) {
    const platform = await import(pathToFileURL(join(config.pkg, 'skill/scripts/parent-platform.mjs')).href)
    const { projectEndpoints } = await import(pathToFileURL(join(config.pkg, 'skill/scripts/parent-runtime.mjs')).href)
    const log = (kind, detail) => appendFileSync(config.log_file, JSON.stringify({ at: new Date().toISOString(), kind, pid: process.pid, argv: process.argv, ...detail }) + '\n', { mode: 0o600 })
    const original = cp.spawn; let suspended = false
    cp.spawn = function (...args) {
      const [executable, argv, options] = args
      const official = options?.cwd === config.project && Array.isArray(argv) && JSON.stringify(argv) === JSON.stringify(['app-server', '--listen', 'stdio://'])
      let proof = null, queueProof = null
      if (official && process.argv[1] === join(config.pkg, 'skill/scripts/parent-watch.mjs')) {
        const spool = projectEndpoints(config.project).find(item => item.id === process.argv.at(-1)), saved = spool?.read(), watcher = platform.processIdentity(process.pid)
        const record = saved?.records.find(record => record.state === 'sending' && record.claim?.channel === 'codex_queue' && sameIdentity(record.claim.owner, watcher))
        if (saved?.harness === 'codex' && sameIdentity(saved.watcher, watcher) && platform.sameProcess(saved.caller.owner) && record && realpathSync(executable) === realpathSync(saved.caller.owner.executable)) {
          queueProof = { endpoint_id: spool.id, session: saved.caller.conversation, queue_owner: watcher, queue_record: record }
          if (config.pause_probe && !suspended && !existsSync(config.disarmed_file) && saved.state !== 'verified' && record.event.type === 'parent_probe') proof = { endpoint_id: spool.id, project: config.project, watcher: saved.watcher, caller: saved.caller, probe: record, spool_before: saved, executable, spawn_argv: argv }
        }
      }
      const child = Reflect.apply(original, this, args)
      if (!official) return child
      const childOwner = config.pause_probe ? null : platform.processIdentity(child.pid)
      log('official_connection_spawn', { child_pid: child.pid, child_owner: childOwner, executable, spawn_argv: argv, owned_fault: Boolean(proof), owned_queue: Boolean(queueProof), ...queueProof })
      const write = child.stdin.write
      child.stdin.write = function (...writeArgs) { log('rpc_write_raw', { child_pid: child.pid, raw: Buffer.isBuffer(writeArgs[0]) ? writeArgs[0].toString('utf8') : writeArgs[0] }); return Reflect.apply(write, this, writeArgs) }
      child.stdout.on('data', chunk => log('rpc_read_raw', { child_pid: child.pid, raw: chunk.toString('utf8') }))
      child.on('close', (code, signal) => log('official_connection_closed', { child_pid: child.pid, child_owner: childOwner, code, signal, child_identity_alive: childOwner ? Boolean(platform.sameProcess(childOwner)) : null }))
      if (proof) {
        process.kill(child.pid, 'SIGSTOP'); suspended = true
        const owner = platform.processIdentity(child.pid)
        if (!owner || !platform.processDescendsFrom(owner, proof.watcher)) { process.kill(child.pid, 'SIGCONT'); fail('ACCEPTANCE_QUEUE_FAULT_CHILD_IDENTITY', '自己spawn childの開始identityが一致しません') }
        Object.assign(proof, { owner, paused_at: new Date().toISOString() })
        writeFileSync(config.pause_file, JSON.stringify(proof, null, 2), { mode: 0o600 }); log('own_connection_sigstop', proof)
        const started = Date.now()
        setTimeout(() => {
          const alive = platform.sameProcess(owner)
          if (alive) { process.kill(owner.pid, 'SIGCONT'); log('own_connection_sigcont', { owner }) }
          else log('own_connection_gone_before_resume', { owner })
          writeFileSync(config.terminal_file, JSON.stringify({ at: new Date().toISOString(), owner, elapsed_ms: Date.now() - started, still_same: alive }, null, 2), { mode: 0o600 })
        }, config.hold_ms).unref()
      }
      return child
    }
    syncBuiltinESMExports()
  }
}
