// 親runtimeの起動・移行・診断・停止。親harnessそのものは停止しない。
import { existsSync, readFileSync, rmSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { ParentSpool, armParentState, failedParentRecords } from './parent-delivery.mjs'
import { atomicJson, readJson, processIdentity, sameProcess, failure, posixQuote, psQuote } from './parent-platform.mjs'
import { registerEndpoint, endpointsFor, forgetEndpoint } from './parent-caller.mjs'
import { ownsParentConnection } from './parent-connect.mjs'
import { launchDetached } from './parent-process.mjs'
import { RoomApi } from './room-api.mjs'
import { runtimeDigest } from './runtime-digest.mjs'

const watcherEntry = fileURLToPath(new URL('./parent-watch.mjs', import.meta.url))
export const setupFor = project => readJson(join(project, '.team', 'setup-state.json'))
export function parentMemberRecord(name, harness, endpoint_id, display = {}) {
  if (!['claude', 'codex', 'grok', 'cursor'].includes(harness) || !/^[0-9a-f-]{36}$/u.test(endpoint_id ?? '')) throw failure('PARENT_MEMBER_BINDING_REQUIRED')
  return { name, roles: ['統括'], harness, ...display, delivery: { kind: 'parent_receiver', harness, endpoint_id } }
}
export function actorEnvironment(project, name) {
  if (setupFor(project).mode !== 'lattice') return null
  const values = { LATTICE_TODO_ACTOR_HOST: { darwin: 'mac', linux: 'linux', win32: 'windows' }[process.platform], LATTICE_TODO_ACTOR_SESSION: name, LATTICE_TODO_ACTOR_AGENT: name }
  atomicJson(join(project, '.team', 'parent-env.json'), values)
  const file = join(project, '.team', process.platform === 'win32' ? 'parent-env.ps1' : 'parent-env.sh')
  writeFileSync(file, Object.entries(values).map(([key, value]) => process.platform === 'win32' ? `$env:${key} = ${psQuote(value)}` : `export ${key}=${posixQuote(value)}`).join('\n') + '\n', { mode: 0o600 })
  return { file, command: `. ${process.platform === 'win32' ? psQuote(file) : posixQuote(file)}` }
}
export function credentialFor(project, state, name) {
  if (process.env.PEERTABLE_CREDENTIAL_FILE) return process.env.PEERTABLE_CREDENTIAL_FILE
  return execFileSync(process.execPath, [fileURLToPath(new URL('./seat-credential.mjs', import.meta.url)), 'prepare', project, state.room, name], { encoding: 'utf8' }).trim()
}
export function projectEndpoints(project) {
  const dir = join(project, '.team', 'parent-delivery')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(id => /^[0-9a-f-]{36}$/u.test(id)).map(id => new ParentSpool(project, id))
}
export async function stopOwnedProcess(owner) {
  if (!owner || !sameProcess(owner)) return
  process.kill(owner.pid, 'SIGTERM')
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && sameProcess(owner)) await delay(50)
  if (sameProcess(owner)) throw failure('PARENT_RECEIVER_STOP_FAILED', `受信process ${owner.pid}が停止しません`)
}
function hasSharedWaiter(spool, state) {
  return state.waiter?.channel === 'claude_asyncRewake' && endpointsFor().some(other => {
    if (other.id === spool.id) return false
    const saved = other.read()
    return saved.runtime !== 'stopped' && saved.waiter?.owner?.pid === state.waiter.owner.pid && saved.waiter?.owner?.started === state.waiter.owner.started
  })
}
export async function stopEndpoint(spool) {
  const state = spool.update({ runtime: 'stopped', closed_at: new Date().toISOString() })
  const sharedWaiter = hasSharedWaiter(spool, state)
  for (const owner of [sharedWaiter ? null : state.waiter?.owner, state.watcher]) await stopOwnedProcess(owner)
  spool.update({ waiter: null, watcher: null })
  spool.transact(saved => {
    for (const record of saved.records) if (record.state === 'ready' || record.state === 'waiting') {
      record.state = 'failed'; record.error_code = 'PARENT_SESSION_CLOSED'; record.receipt = spool.receiptFor(saved, record, 'failed', record.error_code)
    }
  })
  forgetEndpoint(spool)
}
export async function migrateLegacy(spool, api) {
  const file = join(spool.project, '.team', 'parent-watch.json')
  if (!existsSync(file)) return
  const legacy = readJson(file), state = spool.read()
  if (legacy.room !== state.room || legacy.server_url.replace(/\/$/u, '') !== state.server_url || legacy.parent !== state.name || !Number.isSafeInteger(legacy.last_seq)) throw failure('PARENT_LEGACY_CURSOR_INVALID')
  const lock = join(spool.project, '.team', 'parent-watch.lock')
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    const owner = processIdentity(pid)
    if (owner) {
      if (!owner.command.includes(watcherEntry) || !owner.command.includes(spool.project)) throw failure('PARENT_LEGACY_OWNER_UNKNOWN')
      await stopOwnedProcess(owner)
    }
    rmSync(lock, { force: true })
  }
  const { messages } = await api.request('messages')
  const missingEvidence = []
  for (const message of messages) {
    if (message.from === state.name || !(message.to === 'all' || message.to === state.name || message.to_names?.includes(state.name))) continue
    const { delivery } = await api.request(`deliveries?seq=${message.seq}`)
    const receipt = delivery?.[state.name]
    if (receipt?.state === 'delivered' && receipt.reason === 'parent_watch') {
      const record = spool.saveEvent({ schema: 'peertable.parent-watch-event.v1', room: state.room, type: message.to === 'all' ? 'parent_room_update' : 'parent_dm', parent: state.name, ...message, message })
      spool.transact(saved => { const item = saved.records.find(item => item.delivery_id === record.delivery_id); item.state = 'submitted'; item.migration_receipt = receipt; item.accepted_at = receipt.at })
    } else if (message.seq <= legacy.last_seq) missingEvidence.push(message.seq)
  }
  spool.update({ cursor: legacy.last_seq, source_state: { ...legacy }, migration: { legacy_cursor: legacy.last_seq, insufficient_evidence_seqs: missingEvidence, status: missingEvidence.length ? 'evidence_missing' : 'verified', stopped_at: new Date().toISOString() } })
}
export async function startEndpoint(spool, { renewProbe = false } = {}) {
  const state = spool.recover()
  if (!sameProcess(state.caller.owner)) throw failure('PARENT_SESSION_NOT_RUNNING')
  if (!Number.isSafeInteger(state.cursor)) throw failure('PARENT_CURSOR_MISSING')
  const oldProbe = state.records.find(record => record.event.event_id === `probe:${state.probe_id}`)
  const probe = !state.probe_id || renewProbe && oldProbe?.state === 'failed' ? randomUUID() : state.probe_id
  spool.update({ probe_id: probe })
  spool.saveEvent({ schema: 'peertable.parent-watch-event.v1', type: 'parent_probe', event_id: `probe:${probe}`, room: state.room, from: 'peertable', to: state.name, body: `配送確認の符号は ${probe}。` })
  const currentDigest = runtimeDigest()
  if (state.watcher && sameProcess(state.watcher) && state.runtime_digest === currentDigest) return
  if (state.watcher && sameProcess(state.watcher)) await stopOwnedProcess(state.watcher)
  if (state.waiter && sameProcess(state.waiter.owner) && state.runtime_digest !== currentDigest) {
    // 同じClaude sessionの別endpointが使うwaiterは更新時も停止しない。
    if (hasSharedWaiter(spool, state)) throw failure('PARENT_RESTART_REQUIRED', '共有待機の読込sourceを同じ親sessionで更新してください')
    await stopOwnedProcess(state.waiter.owner)
  }
  spool.update({ watcher: null, runtime_digest: currentDigest })
  spool.transact(saved => {
    if (saved.watcher && sameProcess(saved.watcher)) return
    const pid = launchDetached({
      executable: process.execPath, args: [watcherEntry, spool.project, state.name, '--deliver', spool.id], cwd: spool.project,
      env: { ...process.env, PEERTABLE_CREDENTIAL_FILE: state.credential, PEERTABLE_WATCH_NO_STDIN: '1' },
      logFile: join(spool.root, 'watch.log'),
      onError: error => { spool.update({ runtime: 'failed', error_code: 'PARENT_WATCH_START_FAILED', error_detail: error.message }) },
    })
    const identity = processIdentity(pid)
    if (!identity) throw failure('PARENT_WATCH_START_FAILED')
    saved.watcher = identity
  })
}
export async function joinEndpoint(projectArg, name, caller, display = {}) {
  const project = realpathSync(projectArg), setup = setupFor(project)
  const api = new RoomApi(setup, { credential: credentialFor(project, setup, name) })
  const previous = projectEndpoints(project).find(spool => { const saved = spool.read(); return saved.name === name && saved.caller.harness === caller.harness && saved.caller.conversation === caller.conversation })
  let spool = previous
  if (spool) {
    const saved = spool.read()
    if (!Number.isSafeInteger(saved.cursor)) throw failure('PARENT_CURSOR_MISSING')
    const runtime = caller.harness === 'codex' ? 'armed' : saved.waiter && sameProcess(saved.waiter.owner) ? saved.runtime : 'rearm_pending'
    spool.update({ caller, runtime, state: saved.state === 'verified' ? 'verified' : 'receiving', probe_deadline: runtime === 'armed' && saved.state !== 'verified' ? Date.now() + 30000 : null, error_code: null })
  } else {
    for (const old of projectEndpoints(project).filter(item => item.read().name === name && item.read().runtime !== 'stopped')) await stopEndpoint(old)
    const summary = await api.request('summary')
    if (!Number.isSafeInteger(summary.seq)) throw failure('PARENT_START_SEQ_INVALID')
    spool = ParentSpool.create(project, { name, harness: caller.harness, caller, room: setup.room, server_url: setup.server_url.replace(/\/$/u, ''), start_seq: summary.seq, credential: api.credential })
    if ((await api.members()).some(member => member.name === name && member.delivery?.kind === 'parent_watch')) await migrateLegacy(spool, api)
  }
  registerEndpoint(spool)
  spool.update({ global_connection: ownsParentConnection(caller.harness) })
  await api.request('members', { method: 'POST', body: parentMemberRecord(name, caller.harness, spool.id, display) })
  actorEnvironment(project, name)
  // Codexはjoin前に公式queueと同期hookの準備を確認済み。初回も実probeの期限を開始する。
  if (caller.harness === 'codex') spool.transact(armParentState)
  await startEndpoint(spool, { renewProbe: true })
  return spool
}
export async function parentRuntimeStatus(project, { restart = false } = {}) {
  const api = new RoomApi(setupFor(project))
  const parents = (await api.members()).filter(member => ['parent_receiver', 'parent_watch'].includes(member.delivery?.kind))
  const endpoints = projectEndpoints(project)
  const checks = parents.length ? [] : [{ name: null, status: 'failed', error_code: 'PARENT_JOIN_REQUIRED', action: { tool: 'parent_join', arguments: { project } } }]
  for (const member of parents) {
    if (member.delivery.kind === 'parent_watch') { checks.push({ name: member.name, status: 'failed', error_code: 'PARENT_LEGACY_RECEIVER', action: 'parent_join' }); continue }
    const spool = endpoints.find(item => item.id === member.delivery.endpoint_id)
    if (!spool) { checks.push({ name: member.name, status: 'failed', error_code: 'PARENT_ENDPOINT_NOT_FOUND' }); continue }
    try {
      let state = spool.recover()
      if (state.caller.peertable_source_digest !== runtimeDigest()) throw failure('PARENT_RESTART_REQUIRED', '親MCPの読込sourceと現在のpackageが異なります')
      if (restart && sameProcess(state.caller.owner) && state.runtime !== 'stopped') { await startEndpoint(spool); state = spool.read() }
      const live = sameProcess(state.caller.owner) && sameProcess(state.watcher) && state.runtime_digest === runtimeDigest()
      const armed = state.runtime === 'armed' && (state.harness === 'codex' || sameProcess(state.waiter?.owner))
      const unknown = state.records.filter(record => record.state === 'unknown').map(record => record.delivery_id)
      const failed = failedParentRecords(state).map(record => record.delivery_id)
      const missingEvidence = state.migration?.status === 'evidence_missing'
      checks.push({ name: member.name, endpoint_id: spool.id, state: state.state, runtime: state.runtime, status: live && armed && state.state === 'verified' && !state.receipt_error && !state.health_error && !unknown.length && !failed.length && !missingEvidence ? 'ready' : 'failed',
        error_code: state.error_code ?? (!live ? 'PARENT_SESSION_NOT_RUNNING' : !armed ? 'PARENT_REARM_REQUIRED' : state.state !== 'verified' ? 'PARENT_PROBE_PENDING' : state.receipt_error ? 'PARENT_RECEIPT_FAILED' : state.health_error ? 'PARENT_HEALTH_REPORT_FAILED' : unknown.length ? 'PARENT_DELIVERY_UNKNOWN' : failed.length ? 'PARENT_DELIVERY_FAILED' : missingEvidence ? 'PARENT_LEGACY_EVIDENCE_MISSING' : null), unknown, failed, migration: state.migration })
    } catch (error) { checks.push({ name: member.name, status: 'failed', error_code: error.code, detail: error.message }) }
  }
  return { schema: 'peertable.parent-runtime.v1', status: checks.some(check => check.status !== 'ready') ? 'failed' : 'ready', endpoints: checks }
}
