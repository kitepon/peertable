// roomを正本とする配送spool。本文保存とcursor、claimとreceiptは同じatomic更新にする。
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { atomicJson, readJson, processIdentity, sameProcess, failure } from './parent-platform.mjs'
import { RoomApi } from './room-api.mjs'

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const now = () => new Date().toISOString()
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')
export const PAGE_CHARS = 12000
export const eventKinds = ['parent_dm', 'parent_room_update', 'parent_lattice_error', 'parent_lattice_update', 'parent_table_stalled', 'parent_watch_snapshot', 'watch_error', 'parent_probe']
export function armParentState(state) {
  state.runtime = 'armed'
  if (state.state !== 'verified' && state.probe_deadline == null) state.probe_deadline = Date.now() + 30000
}
// 明示再登録で新しいprobeが届いた場合だけ、既知の失敗probeを解決済みにする。
export const failedParentRecords = state => state.records.filter(record => record.state === 'failed' && !(record.event.type === 'parent_probe' && record.resolved_by))

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
    atomicJson(spool.file, { schema: 'peertable.parent-spool.v1', endpoint_id: spool.id,
      generation: randomUUID(), ...binding, state: 'receiving', runtime: 'rearm_pending', created_at: now(),
      continuation_key: randomBytes(32).toString('hex'), records: [], quiet_events: [], cursor: binding.start_seq,
      watcher: null, waiter: null, source_state: null, migration: null })
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
      for (const record of saved.records) if (record.state === 'ready' || record.state === 'waiting') {
        record.state = 'failed'; record.error_code = saved.error_code
        record.receipt = null
      }
    })
    throw failure('PARENT_ENDPOINT_SUPERSEDED')
  }
  async publishHealth() {
    const saved = this.read()
    const state = saved.runtime === 'armed' && (saved.state !== 'verified' || saved.receipt_error || saved.migration?.status === 'evidence_missing' || saved.records.some(record => record.state === 'unknown') || failedParentRecords(saved).length) ? 'failed' : saved.runtime
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
        claim: null, receipt: null, queued_submission_id: null, accepted_at: null }
      state.records.push(record)
      return record
    })
  }
  saveCursor(cursor, sourceState) {
    return this.transact(state => { state.cursor = cursor; state.source_state = sourceState })
  }
  recover() {
    return this.transact(state => {
      for (const record of state.records) {
        if (record.claim?.page_inflight && !sameProcess(record.claim.page_owner)) {
          this.markUnknown(state, record, 'PARENT_PAGE_OUTPUT_INTERRUPTED')
          continue
        }
        const durableHookClaim = join(this.root, 'queue-claims', `${record.delivery_id}.json`)
        if (!record.hook_claim && existsSync(durableHookClaim)) {
          const claim = readJson(durableHookClaim)
          if (claim.delivery_id !== record.delivery_id || claim.endpoint_id !== this.id || claim.digest !== record.queue_digest) throw failure('PARENT_CLAIM_MISMATCH')
          record.hook_claim = claim
          record.hook_state = 'claimed'
        }
        if (record.hook_claim && record.hook_state !== 'output_complete' && !sameProcess(record.hook_claim.owner)) {
          this.markUnknown(state, record, 'PARENT_CODEX_HOOK_INTERRUPTED')
          continue
        }
        if (record.state === 'sending' && !record.claim?.handoff && !sameProcess(record.claim?.owner)) {
          this.markUnknown(state, record, 'PARENT_OUTPUT_INTERRUPTED')
        }
      }
      if (state.waiter && !sameProcess(state.waiter.owner)) {
        state.waiter = null
        if (state.runtime !== 'stopped') state.runtime = 'rearm_pending'
      }
      return state
    })
  }
  claim(channel, deliveryId = null) {
    return this.transact(state => {
      if (state.runtime === 'stopped' || state.state === 'failed') return null
      const record = deliveryId ? state.records.find(item => item.delivery_id === deliveryId && item.state === 'ready') : state.records.find(item => item.state === 'ready')
      if (!record) return null
      // readyの先頭だけをclaimし、受信側ごとの並列出力による順序逆転を止める。
      if (state.records.some(item => item.state === 'sending')) return null
      record.state = 'sending'
      record.claim = { id: randomUUID(), channel, owner: processIdentity(process.pid), at: now(), handoff: false, offset: 0 }
      return record
    })
  }
  handoff(record) {
    return this.transact(state => {
      const saved = this.owned(state, record)
      saved.claim.handoff = true
      return saved
    })
  }
  owned(state, record) {
    const saved = state.records.find(item => item.delivery_id === record.delivery_id)
    if (!saved || saved.claim?.id !== record.claim?.id) throw failure('PARENT_CLAIM_MISMATCH')
    return saved
  }
  receiptFor(state, record, result, reason) {
    return Number.isSafeInteger(record.event.seq) ? { seq: record.event.seq, recipient: state.name, result, reason, route: 'parent_receiver', endpoint_id: this.id,
      receipt_revision: (record.receipt?.receipt_revision ?? 0) + 1,
      queued_submission_id: record.queued_submission_id, accepted_at: record.accepted_at, pending: true } : null
  }
  markUnknown(state, record, code) {
    if (record.state === 'unknown' && record.error_code === code) return
    record.state = 'unknown'; record.error_code = code
    record.receipt = this.receiptFor(state, record, 'unknown', code)
  }
  finish(record, options = {}) {
    return this.transact(state => {
      const saved = this.owned(state, record)
      return this.complete(state, saved, options)
    })
  }
  complete(state, saved, { state: outcome = 'submitted', reason = saved.claim.channel, queued_submission_id, accepted_at, resolve_unknown = false } = {}) {
      if (queued_submission_id && saved.queued_submission_id && saved.queued_submission_id !== queued_submission_id) throw failure('PARENT_QUEUE_ACCEPTANCE_CONFLICT')
      if (accepted_at && saved.accepted_at && saved.accepted_at !== accepted_at) throw failure('PARENT_QUEUE_ACCEPTANCE_CONFLICT')
      // queueの遅延受付は後段のunknownを消さない。受付証拠だけを追加する。
      saved.state = saved.state === 'unknown' && queued_submission_id && !resolve_unknown ? 'unknown' : outcome
      saved.completed_at = now()
      if (queued_submission_id) saved.queued_submission_id = queued_submission_id
      if (accepted_at) saved.accepted_at = accepted_at
      saved.receipt = this.receiptFor(state, saved, saved.state === 'submitted' ? 'delivered' : saved.state, saved.state === 'unknown' && outcome === 'submitted' ? saved.receipt?.reason ?? reason : reason)
      if (saved.event.type === 'parent_probe' && saved.state === 'submitted' && (!state.probe_id || saved.event.event_id === `probe:${state.probe_id}`)) {
        state.state = 'verified'
        for (const previous of state.records) if (previous.event.type === 'parent_probe' && previous.state === 'failed') previous.resolved_by = saved.delivery_id
        if (state.error_code === 'PARENT_PROBE_TIMEOUT') {
          state.error_code = null
          if (state.runtime === 'failed') state.runtime = state.harness === 'codex' || sameProcess(state.waiter?.owner) ? 'armed' : 'rearm_pending'
        }
      }
      return saved
  }
  token(record, offset) {
    const state = this.read()
    const payload = Buffer.from(JSON.stringify({ endpoint: this.id, generation: state.generation, delivery: record.delivery_id, digest: record.digest, claim: record.claim.id, offset })).toString('base64url')
    return `${payload}.${createHmac('sha256', state.continuation_key).update(payload).digest('base64url')}`
  }
  page(deliveryId, continuationToken = null) {
    let selected, offset = 0
    if (continuationToken) {
      const [payload, signature] = continuationToken.split('.')
      const state = this.read()
      const expected = createHmac('sha256', state.continuation_key).update(payload ?? '').digest('base64url')
      if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw failure('PARENT_CONTINUATION_INVALID')
      let data
      try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()) } catch { throw failure('PARENT_CONTINUATION_INVALID') }
      selected = state.records.find(item => item.delivery_id === data.delivery)
      if (!selected || data.endpoint !== this.id || data.generation !== state.generation || data.digest !== selected.digest || data.claim !== selected.claim?.id || selected.state !== 'sending' || data.offset !== selected.claim.offset || (deliveryId && deliveryId !== data.delivery)) throw failure('PARENT_CONTINUATION_MISMATCH')
      offset = data.offset
    } else {
      const state = this.read()
      selected = state.records.find(item => item.state === 'sending' && item.claim?.handoff && (!deliveryId || item.delivery_id === deliveryId)) ?? this.claim('parent_read', deliveryId)
      if (selected?.claim.offset > 0) throw failure('PARENT_CONTINUATION_REQUIRED')
    }
    if (!selected) return null
    const pageClaim = randomUUID()
    this.transact(state => {
      const saved = this.owned(state, selected)
      if (saved.state !== 'sending' || saved.claim.offset !== offset) throw failure('PARENT_CONTINUATION_MISMATCH')
      if (saved.claim.page_inflight) throw failure('PARENT_READ_IN_PROGRESS')
      saved.claim.page_inflight = pageClaim
      saved.claim.page_owner = processIdentity(process.pid)
      saved.claim.page_started_at = now()
    })
    let end = Math.min(offset + PAGE_CHARS, String(selected.event.body ?? '').length)
    // UTF-16のsurrogate pairをページ境界で分割しない。
    const body = String(selected.event.body ?? '')
    if (end < body.length && /[\uD800-\uDBFF]/u.test(body[end - 1])) end--
    const final = end === body.length
    return { record: selected, page_claim: pageClaim, offset, end, final, result: { schema: 'peertable.parent-read-page.v1', endpoint_id: this.id,
      delivery_id: selected.delivery_id, digest: selected.digest, event: { ...selected.event, body: body.slice(offset, end), message: selected.event.message ? { ...selected.event.message, body: body.slice(offset, end) } : undefined },
      offset, total_characters: body.length, complete: final, continuation_token: final ? null : this.token(selected, end) } }
  }
  pageWritten(page) {
    return this.transact(state => {
      const saved = this.owned(state, page.record)
      if (saved.claim.page_inflight !== page.page_claim) throw failure('PARENT_PAGE_CLAIM_MISMATCH')
      if (saved.state !== 'sending') throw failure('PARENT_PAGE_OUTPUT_UNKNOWN')
      saved.claim.page_inflight = null
      saved.claim.page_owner = null
      if (page.final) return this.complete(state, saved, { reason: 'parent_read_complete' })
      saved.claim.offset = page.end
      saved.claim.handoff = true
      return saved
    })
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
  slot(channel, receipt = null) {
    return this.transact(state => {
      if (state.waiter && sameProcess(state.waiter.owner)) return null
      if (state.runtime === 'stopped') return null
      const waiter = { waiter_id: receipt?.waiter_id ?? randomUUID(), generation: receipt?.generation ?? randomUUID(), channel, owner: processIdentity(process.pid), started_at: now(), native_task: null }
      if (receipt && (state.wait_receipt?.waiter_id !== receipt.waiter_id || state.wait_receipt?.generation !== receipt.generation)) throw failure('PARENT_WAITER_MISMATCH')
      state.waiter = waiter
      if (channel === 'claude_asyncRewake') armParentState(state)
      else state.runtime = 'rearm_pending'
      return waiter
    })
  }
  releaseSlot(waiter, outcome = 'rearm_pending') {
    this.transact(state => { if (state.waiter?.waiter_id === waiter.waiter_id && state.waiter?.generation === waiter.generation) { state.waiter = null; state.runtime = outcome } })
  }
}

// 通知はroomの観測データとして描画する。本文へ追加の行動命令を混ぜない。
export function renderDelivery(state, record, { preview = false } = {}) {
  const event = record.event
  const body = String(event.body ?? '')
  return `[Peertable room=${state.room} from=${event.from ?? 'peertable'} to=${JSON.stringify(event.to_names ?? event.to ?? state.name)} seq=${event.seq ?? event.event_id ?? record.delivery_id}]\n本文: ${preview ? body.slice(0, PAGE_CHARS) : body}\n[配送ID=${record.delivery_id} digest=${record.digest}${preview ? ' 全文取得=parent_read' : ''}]`
}
