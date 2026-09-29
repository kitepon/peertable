// roomを正本とする配送spool。本文の保存、roomのcursor、配送の状態、roomへのreceiptを同じatomic更新にする。
// 親への配送そのものはAitermと同じ方式（aiterm-steer-delivery のchannel）で行う。
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicJson, readJson, processIdentity, sameProcess, failure } from './parent-platform.mjs'
import { RoomApi } from './room-api.mjs'
import { PEERTABLE_PROFILE, steer } from './parent-steer.mjs'

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const now = () => new Date().toISOString()
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')
export const eventKinds = ['parent_dm', 'parent_room_update', 'parent_lattice_error', 'parent_lattice_update', 'parent_table_stalled', 'parent_watch_snapshot', 'watch_error']
// 配送の経路。receiptのreasonに載せる。
const routeReason = { claude_hook: 'claude_asyncRewake_output', cursor_hook: 'cursor_hook_output', receiver: 'background_receiver_output' }

export function withParentLock(root, fn) {
    const owner = processIdentity(process.pid)
    if (!owner) throw failure('PARENT_PROCESS_IDENTITY_UNAVAILABLE')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const id = randomUUID(), file = join(root, `${id}.json`), deadline = Date.now() + 10000
    // Bakery排他。stale ownerの共有fileを消さず、自分の番号だけを所有する。
    const participants = () => readdirSync(root).filter(name => /^[0-9a-f-]{36}\.json$/u.test(name)).flatMap(name => {
      let entry
      try { entry = readJson(join(root, name)) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
      if (!sameProcess(entry.owner)) { rmSync(join(root, name), { force: true }); return [] }
      return [entry]
    })
    const ticket = { id, owner, choosing: true, number: 0 }
    atomicJson(file, ticket)
    try {
      ticket.number = Math.max(0, ...participants().map(entry => entry.number)) + 1
      ticket.choosing = false
      atomicJson(file, ticket)
      while (participants().some(entry => entry.id !== id && (entry.choosing || entry.number < ticket.number || (entry.number === ticket.number && entry.id < id)))) {
        if (Date.now() >= deadline) throw failure('PARENT_SPOOL_LOCK_TIMEOUT')
        pause(15)
      }
      return fn()
    } finally { rmSync(file, { force: true }) }
}

export class ParentSpool {
  constructor(project, endpointId) {
    if (!/^[0-9a-f-]{36}$/u.test(endpointId)) throw failure('PARENT_ENDPOINT_INVALID')
    this.project = project
    this.id = endpointId
    this.root = join(project, '.team', 'parent-delivery', endpointId)
    this.file = join(this.root, 'spool.json')
    this.lock = join(this.root, 'transactions')
  }
  static create(project, binding) {
    const spool = new ParentSpool(project, binding.endpoint_id ?? randomUUID())
    mkdirSync(spool.root, { recursive: true, mode: 0o700 })
    if (existsSync(spool.file)) throw failure('PARENT_ENDPOINT_ALREADY_EXISTS')
    atomicJson(spool.file, { schema: 'peertable.parent-spool.v2', endpoint_id: spool.id,
      generation: randomUUID(), ...binding, state: 'receiving', runtime: 'armed', created_at: now(),
      records: [], quiet_events: [], cursor: binding.start_seq, watcher: null, source_state: null, migration: null })
    return spool
  }
  read() { return readJson(this.file) }
  transact(fn) {
    return withParentLock(this.lock, () => {
      const state = this.read()
      const result = fn(state)
      atomicJson(this.file, state)
      return result
    })
  }
  update(fields) { return this.transact(state => { Object.assign(state, fields); return state }) }
  async assertCurrentEndpoint(api = new RoomApi(this.read(), { credential: this.read().credential })) {
    const state = this.read()
    const member = (await api.members()).find(member => member.name === state.name)
    if (member?.delivery?.kind === 'parent_receiver' && member.delivery.endpoint_id === this.id) return
    this.transact(saved => {
      saved.runtime = 'stopped'; saved.state = 'failed'; saved.error_code = 'PARENT_ENDPOINT_SUPERSEDED'
      for (const record of saved.records) if (record.state === 'ready') {
        record.state = 'failed'; record.error_code = saved.error_code
        record.receipt = null
      }
    })
    if (this.read().channel) steer.closeChannel(PEERTABLE_PROFILE, this.read().channel.channel_id, 'superseded')
    throw failure('PARENT_ENDPOINT_SUPERSEDED')
  }
  async publishHealth() {
    const saved = this.read()
    const state = saved.runtime === 'armed' && (saved.receipt_error || saved.migration?.status === 'evidence_missing' || saved.records.some(record => ['unknown', 'failed'].includes(record.state))) ? 'failed' : saved.runtime
    try {
      await new RoomApi(saved, { credential: saved.credential }).request('bridges', { method: 'POST', body: { kind: 'parent_receiver', recipient: saved.name, endpoint_id: this.id, pid: process.pid, state, detail: JSON.stringify({ endpoint_id: this.id, state: saved.state, error_code: saved.error_code ?? saved.receipt_error?.code ?? null }) } })
      this.update({ health_error: null })
    } catch (error) { this.update({ health_error: { code: error.code, detail: error.message } }); process.stderr.write(`${error.code}: ${error.message}\n`) }
  }
  eventIdentity(event, state) {
    return digest([state.server_url, state.room, state.name, state.generation,
      Number.isSafeInteger(event.seq) ? `seq:${event.seq}` : event.event_id ?? digest(event)])
  }
  saveEvent(event, { quiet = false } = {}) {
    return this.transact(state => {
      const key = this.eventIdentity(event, state)
      const existing = state.records.find(record => record.key === key)
      if (existing) return existing
      if (quiet) {
        if (!state.quiet_events.some(item => item.key === key)) state.quiet_events.push({ key, event, reason: 'lattice_counts_quiet', at: now() })
        return null
      }
      const record = { delivery_id: randomUUID(), key, digest: digest(event), event, state: 'ready', saved_at: now(),
        channel_id: null, receipt: null, queued_submission_id: null, accepted_at: null }
      state.records.push(record)
      return record
    })
  }
  saveCursor(cursor, sourceState) {
    return this.transact(state => { state.cursor = cursor; state.source_state = sourceState })
  }
  receiptFor(state, record, result, reason) {
    return Number.isSafeInteger(record.event.seq) ? { seq: record.event.seq, recipient: state.name, result, reason, route: 'parent_receiver', endpoint_id: this.id,
      receipt_revision: (record.receipt?.receipt_revision ?? 0) + 1,
      queued_submission_id: record.queued_submission_id, accepted_at: record.accepted_at, pending: true } : null
  }
  settle(deliveryId, outcome, reason, fields = {}) {
    return this.transact(state => {
      const record = state.records.find(item => item.delivery_id === deliveryId)
      if (!record) throw failure('PARENT_DELIVERY_UNKNOWN')
      Object.assign(record, fields)
      record.state = outcome
      if (outcome !== 'ready' && outcome !== 'sending') {
        record.completed_at = now()
        if (outcome !== 'submitted') record.error_code = reason
        record.receipt = this.receiptFor(state, record, outcome === 'submitted' ? 'delivered' : outcome, reason)
      }
      return record
    })
  }
  /** readyの本文を到着順に親のchannelへ送る。Codexは公式キューの受付で、それ以外は受け口の出力でdeliveredになる。 */
  async deliverReady() {
    for (;;) {
      const record = this.transact(state => {
        if (state.runtime === 'stopped' || !state.channel) return null
        const item = state.records.find(entry => entry.state === 'ready')
        if (!item) return null
        item.state = 'sending'; item.channel_id = state.channel.channel_id; item.sent_at = now()
        return item
      })
      if (!record) return
      try {
        const result = await steer.sendToChannel(PEERTABLE_PROFILE, record.channel_id, record.delivery_id, renderDelivery(this.read(), record))
        if (result.state === 'submitted') this.settle(record.delivery_id, 'submitted', 'codex_queue_accepted', { queued_submission_id: result.queued_submission_id, accepted_at: now() })
      } catch (error) {
        // 送信の成否が確定しない失敗は自動で再送しない（Aitermと同じ）。
        this.settle(record.delivery_id, error.outcome_unknown ? 'unknown' : 'failed', error.delivery_code ?? error.code ?? 'PARENT_DELIVERY_FAILED')
      }
    }
  }
  /** 受け口の出力状況をspoolへ写す。取り下げた本文と、channelの記録が無い本文は、次のchannelで送り直す。 */
  syncStates() {
    const state = this.read()
    for (const record of state.records) {
      if (record.state === 'submitted' && record.queued_submission_id && state.channel?.kind === 'codex' && state.caller.codex) {
        const hook = steer.codexHookDeliveryState(state.caller.codex.codex_home, state.caller.codex.thread_id, record.delivery_id, steer.codexHookDirectory(PEERTABLE_PROFILE))
        if (hook === 'unknown' && record.error_code !== 'CODEX_HOOK_DELIVERY_UNCONFIRMED') this.settle(record.delivery_id, 'unknown', 'CODEX_HOOK_DELIVERY_UNCONFIRMED')
        continue
      }
      if (record.state !== 'sending' || !record.channel_id) continue
      let current
      try { current = steer.channelDeliveryState(PEERTABLE_PROFILE, record.channel_id, record.delivery_id) }
      catch (error) { if (error.delivery_code === 'CHANNEL_UNKNOWN') current = null; else throw error }
      if (current === 'emitted') {
        const by = readEmittedBy(record.channel_id, record.delivery_id)
        this.settle(record.delivery_id, 'submitted', routeReason[by] ?? 'parent_receiver_output', { accepted_at: now() })
      } else if (current === 'unknown') this.settle(record.delivery_id, 'unknown', 'PARENT_OUTPUT_UNKNOWN')
      else if (current === 'withdrawn' || current === null) this.settle(record.delivery_id, 'ready', null, { channel_id: null })
    }
  }
  /** 親の会話へ新しいchannelを張る。前のchannelでまだ誰も受け取っていない本文は取り下げて、新しいchannelで送る。 */
  rebind(channel, caller) {
    const previous = this.read().channel
    this.transact(state => { state.channel = { channel_id: channel.channel_id, kind: channel.kind }; state.caller = caller; state.runtime = 'armed'; state.state = 'receiving'; state.error_code = null })
    if (!previous || previous.channel_id === channel.channel_id) return
    steer.closeChannel(PEERTABLE_PROFILE, previous.channel_id, 'rebound')
    for (const record of this.read().records.filter(item => item.state === 'sending' && item.channel_id === previous.channel_id)) {
      if (previous.kind !== 'codex' && steer.withdrawFromChannel(PEERTABLE_PROFILE, previous.channel_id, record.delivery_id)) this.settle(record.delivery_id, 'ready', null, { channel_id: null })
    }
  }
  async flushReceipts(api) {
    const pending = this.read().records.filter(item => item.receipt?.pending)
    for (const item of pending) {
      const { pending: ignored, ...body } = item.receipt
      try {
        await api.request('deliveries', { method: 'POST', body })
        this.transact(state => {
          const saved = state.records.find(record => record.delivery_id === item.delivery_id)
          if (digest(saved.receipt) === digest(item.receipt)) saved.receipt.pending = false
          state.receipt_error = null
        })
      } catch (error) {
        this.transact(state => {
          const saved = state.records.find(record => record.delivery_id === item.delivery_id)
          // 古いHTTP要求の失敗で、新しいreceiptの成功診断を上書きしない。
          if (digest(saved.receipt) === digest(item.receipt)) state.receipt_error = { code: error.code, detail: error.message, at: now() }
        })
        throw error
      }
    }
  }
  async flushReceiptsAfterOutput(api = new RoomApi(this.read(), { credential: this.read().credential })) {
    // 本文の出力成否とHTTP receiptの失敗は別。失敗分はpendingのままsourceが再送する。
    try { await this.flushReceipts(api) }
    catch (error) { process.stderr.write(`${error.code ?? 'PARENT_RECEIPT_FAILED'}: ${error.message}\n`) }
  }
}

function readEmittedBy(channelId, deliveryId) {
  try { return readJson(join(PEERTABLE_PROFILE.state_root(), 'steer-channels', channelId, 'emitted', `${deliveryId}.json`)).by }
  catch { return null }
}

// 通知はroomの観測データとして描画する。本文へ追加の行動命令を混ぜない。
export function renderDelivery(state, record) {
  const event = record.event
  const body = String(event.body ?? '')
  return `[Peertable room=${state.room} from=${event.from ?? 'peertable'} to=${JSON.stringify(event.to_names ?? event.to ?? state.name)} seq=${event.seq ?? event.event_id ?? record.delivery_id}]\n本文: ${body}\n[配送ID=${record.delivery_id} digest=${record.digest}]`
}
