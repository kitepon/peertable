// Codex正規MCPの初回receiverだけを停止する。caller metadata/時計/RPC応答は変更しない。
import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import cp from 'node:child_process'
import { queueFaultRpcRows } from './scenarios-queue-fault.mjs'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const same = (a, b) => a && b && a.pid === b.pid && a.started === b.started
const logRows = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []

// data listenerを追加するとSDK起動前にstdinがflowingになる。既存emitだけを受動観測する。
export function observeReceiverStdin(stream, record) {
  const emit = stream.emit
  stream.emit = function (...args) { if (args[0] === 'data') record(args[1]); return Reflect.apply(emit, this, args) }
}

// 改行確定とUTF-8 chunk復元はqueue observerと同じ処理。channelの原bytesも返す。
export function receiverMcpRows(events, channel) {
  return queueFaultRpcRows(events.filter(event => event.kind === channel).map(event => ({ ...event, kind: channel === 'mcp_input_raw' ? 'rpc_write_raw' : 'rpc_read_raw', child_pid: event.pid })))
}

export function receiverPreparationOwner({ events, parent, mcp, executable, project, name, endpoints, sameProcess, processDescendsFrom }) {
  const input = receiverMcpRows(events, 'mcp_input_raw').filter(event => event.pid === mcp.pid)
  const initialized = input.find(event => event.row.method === 'initialize')
  const joins = input.filter(event => event.row.method === 'tools/call' && event.row.params?.name === 'parent_join')
  const request = joins.at(-1)
  if (initialized?.row.params?.clientInfo?.name !== 'codex-mcp-client' || joins.length !== 1 || !request || !['string', 'number'].includes(typeof request.row.id) || typeof request.row.params._meta?.threadId !== 'string' || !request.row.params._meta.threadId || request.row.params.arguments?.project !== project || request.row.params.arguments?.name !== name) fail('ACCEPTANCE_RECEIVER_MCP_CALLER_UNBOUND', '初回正規MCP入力のclient/requestId/threadId/project/nameが一致しません')
  if (!sameProcess(parent) || !sameProcess(mcp) || !processDescendsFrom(mcp, parent) || realpathSync(executable) !== realpathSync(parent.executable) || endpoints.length) fail('ACCEPTANCE_RECEIVER_PREPARATION_OWNER', '専用親/MCP/binary又はendpoint作成前の境界が一致しません')
  return { parent, mcp, executable, project, session: request.row.params._meta.threadId, request, initialize: initialized, endpoints_before: endpoints }
}

export function receiverPreparationFailure({ events, pause, native, endpoints, health, sameProcess }) {
  const rpc = queueFaultRpcRows(events), initialized = rpc.find(event => event.pid === pause.mcp.pid && event.child_pid === pause.owner.pid && event.kind === 'rpc_write_raw' && event.row.method === 'initialize')
  const output = receiverMcpRows(events, 'mcp_output_raw').find(event => event.pid === pause.mcp.pid && event.row.id === pause.request.row.id)
  const error = output?.row.result?.structuredContent
  const closed = events.find(event => event.kind === 'receiver_child_closed' && same(event.owner, pause.owner) && event.pid === pause.mcp.pid)
  if (!initialized || rpc.some(event => event.pid === pause.mcp.pid && event.child_pid === pause.owner.pid && event.kind === 'rpc_read_raw' && event.row.id === initialized.row.id)) fail('ACCEPTANCE_RECEIVER_TIMEOUT_STAGE', 'initial receiver initializeの無応答期限ではありません')
  if (error?.schema !== 'peertable.parent-error.v1' || error.state !== 'failed' || error.error_code !== 'PARENT_CODEX_RPC_TIMEOUT' || error.detail !== 'initialize' || output.row.result.isError !== true || !native || native.session !== pause.session || !isDeepStrictEqual(native.result, error) || !isDeepStrictEqual(native.arguments, pause.request.row.params.arguments)) fail('ACCEPTANCE_RECEIVER_RPC_FAILURE_MISSING', '原MCP出力と同CID公式completed itemに同じRPC期限failureがありません')
  const elapsed = Date.parse(output.at) - Date.parse(initialized.at)
  if (!Number.isFinite(elapsed) || elapsed < 15000 || !closed || closed.identity_alive !== false || sameProcess(pause.owner) || endpoints.length || !Array.isArray(health.members) || health.members.some(member => member.name === pause.request.row.params.arguments.name && member.delivery?.kind === 'parent_receiver') || !sameProcess(pause.parent)) fail('ACCEPTANCE_RECEIVER_PREJOIN_FAILURE_BOUNDARY', '実15秒期限/own child消失/親存命/新endpoint未作成が揃いません')
  return { session: pause.session, native, original_request: pause.request, original_output: output, initialize_request: initialized, rpc_failure_elapsed_ms: elapsed, parent_owner: pause.parent, mcp_owner: pause.mcp, receiver_owner: pause.owner, closed, endpoints_after: endpoints, health }
}

export function codexReceiverFailureBoundary({ file, session, arguments: args, after = -1 }) {
  const lines = readFileSync(file, 'utf8').split('\n'); lines.pop(); let cid
  for (const [order, line] of lines.entries()) {
    let row
    try { row = JSON.parse(line) } catch { fail('ACCEPTANCE_TRANSCRIPT_CORRUPT', 'Codex確定transcript行がJSONではありません') }
    if (row.type === 'session_meta') cid = row.payload.id
    const p = row.payload, item = p?.item, result = item?.result?.structuredContent
    // 公式generate-json-schemaのMcpToolCallStatus。確定したerror結果だけを照合する。
    if (order > after && cid === session && row.type === 'event_msg' && p.type === 'item_completed' && p.thread_id === session && p.turn_id && item?.type === 'McpToolCall' && item.server === 'peertable_parent' && item.tool === 'parent_join' && ['completed', 'failed'].includes(item.status) && isDeepStrictEqual(item.arguments, args) && result?.schema === 'peertable.parent-error.v1' && result.state === 'failed' && result.error_code === 'PARENT_CODEX_RPC_TIMEOUT') return { session, turn_id: p.turn_id, id: item.id, order, arguments: item.arguments, result, raw: row }
  }
  return null
}

export async function installReceiverPreparationFault(fixture, { pkg, artifact }) {
  if (fixture.harness !== 'codex' || fixture.pty) fail('ACCEPTANCE_RECEIVER_FAULT_PREPARATION_ORDER', 'Codex専用親の起動前だけにreceiver observerを準備します')
  if (process.platform === 'win32') fail('ACCEPTANCE_RECEIVER_FAULT_OS_API_UNCONFIRMED', 'Windowsのown receiver停止APIは未実測です')
  const configFile = artifact('receiver-fault-config'), logFile = artifact('receiver-mcp-rpc-os.jsonl'), pauseFile = artifact('receiver-suspended'), disarmed = artifact('receiver-disarmed')
  const config = { pkg, project: fixture.project, name: fixture.name, log_file: logFile, pause_file: pauseFile, disarmed_file: disarmed }
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
  const prior = fixture.processEnvironment ?? {}
  fixture.processEnvironment = { ...prior, NODE_OPTIONS: [prior.NODE_OPTIONS ?? process.env.NODE_OPTIONS, `--import=${import.meta.url}`].filter(Boolean).join(' '), PEERTABLE_ACCEPTANCE_RECEIVER_FAULT: configFile }
  const platform = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-platform.mjs')).href)
  return { config_file: configFile, log_file: logFile, events: () => logRows(logFile), pause: () => existsSync(pauseFile) ? JSON.parse(readFileSync(pauseFile, 'utf8')) : null,
    bindParent(parent) { if (!platform.sameProcess(parent)) fail('ACCEPTANCE_RECEIVER_NATIVE_PARENT_GONE', '起動済み専用親が存命ではありません'); config.parent = parent; writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 }) },
    async close() { writeFileSync(disarmed, '{}', { mode: 0o600 }); const paused = this.pause(); if (paused && platform.sameProcess(paused.owner)) { process.kill(paused.owner.pid, 'SIGCONT'); appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), kind: 'finalize_receiver_sigcont', owner: paused.owner }) + '\n') } },
  }
}

// own MCPだけ。watcher/別MCP/親CLIに同じmoduleが継承されても作用しない。
const configPath = process.env.PEERTABLE_ACCEPTANCE_RECEIVER_FAULT
if (configPath && existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (process.cwd() === config.project && process.argv[1] === join(config.pkg, 'room/parent-client.mjs')) {
    const platform = await import(pathToFileURL(join(config.pkg, 'skill/scripts/parent-platform.mjs')).href)
    const { projectEndpoints } = await import(pathToFileURL(join(config.pkg, 'skill/scripts/parent-runtime.mjs')).href)
    const log = (kind, detail) => appendFileSync(config.log_file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, ...detail }) + '\n', { mode: 0o600 })
    const bytes = (data, encoding) => Buffer.isBuffer(data) ? data : Buffer.from(data, typeof encoding === 'string' ? encoding : 'utf8')
    observeReceiverStdin(process.stdin, chunk => log('mcp_input_raw', { raw_base64: bytes(chunk).toString('base64') }))
    const output = process.stdout.write
    process.stdout.write = function (...args) { log('mcp_output_raw', { raw_base64: bytes(args[0], args[1]).toString('base64') }); return Reflect.apply(output, this, args) }
    const original = cp.spawn; let stopped = false
    cp.spawn = function (...args) {
      const [executable, argv, options] = args
      if (stopped || existsSync(config.disarmed_file) || options?.cwd !== config.project || !isDeepStrictEqual(argv, ['app-server', '--listen', 'stdio://'])) return Reflect.apply(original, this, args)
      const active = JSON.parse(readFileSync(configPath, 'utf8')), mcp = platform.processIdentity(process.pid), actual = platform.harnessProcess('codex')
      if (!same(active.parent, actual)) fail('ACCEPTANCE_RECEIVER_NATIVE_PARENT_MISMATCH', '公式MCP祖先が指定fixtureの親本人ではありません')
      const proof = receiverPreparationOwner({ events: logRows(config.log_file), parent: actual, mcp, executable, project: config.project, name: config.name, endpoints: projectEndpoints(config.project).map(item => item.id), ...platform })
      const child = Reflect.apply(original, this, args)
      process.kill(child.pid, 'SIGSTOP'); stopped = true
      const owner = platform.processIdentity(child.pid)
      if (!owner || owner.parent !== mcp.pid || !platform.processDescendsFrom(owner, mcp) || !platform.sameProcess(owner) || realpathSync(owner.executable) !== realpathSync(executable)) { process.kill(child.pid, 'SIGCONT'); fail('ACCEPTANCE_RECEIVER_CHILD_IDENTITY', '停止したinitial receiverの本人identityが一致しません') }
      const pause = { ...proof, owner, spawn_argv: argv, spawn_cwd: options.cwd, paused_at: new Date().toISOString() }
      writeFileSync(config.pause_file, JSON.stringify(pause), { mode: 0o600 }); log('receiver_child_sigstop', pause)
      const write = child.stdin.write
      child.stdin.write = function (...args) { log('rpc_write_raw', { child_pid: child.pid, raw_base64: bytes(args[0], args[1]).toString('base64') }); return Reflect.apply(write, this, args) }
      child.stdout.on('data', chunk => log('rpc_read_raw', { child_pid: child.pid, raw_base64: bytes(chunk).toString('base64') }))
      child.on('close', (code, signal) => log('receiver_child_closed', { owner, code, signal, identity_alive: Boolean(platform.sameProcess(owner)) }))
      // 実RPCの15秒期限とcloseの2秒制御を先に通す。停止中のSIGTERM保留も自己本人だけを解除する。
      setTimeout(() => { const alive = platform.sameProcess(owner); if (alive) process.kill(owner.pid, 'SIGCONT'); log('receiver_fault_release', { owner, still_same: Boolean(alive) }) }, 18000).unref()
      return child
    }
    syncBuiltinESMExports()
  }
}
