import { setTimeout as delay } from 'node:timers/promises'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { sameProcess, parentHome, atomicJson, readJson, processIdentity, failure } from '../parent-platform.mjs'
import { PAGE_CHARS, renderDelivery, digest, withParentLock } from '../parent-delivery.mjs'
import { endpointsFor } from '../parent-caller.mjs'

export async function claudeRewake(spools, write, { leaseMs = 86340000, slotRoot = join(parentHome(), 'claude-session-slots'), listEndpoints = endpointsFor } = {}) {
  if (!Array.isArray(spools)) spools = [spools]
  if (!spools.length) return 0
  const session = spools[0].read().caller.conversation
  const root = slotRoot
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const slot = join(root, digest(session))
  mkdirSync(slot, { recursive: true })
  const ownerFile = join(slot, 'owner.json')
  const own = processIdentity(process.pid)
  const acquired = withParentLock(join(slot, 'transactions'), () => {
    if (existsSync(ownerFile) && sameProcess(readJson(ownerFile))) return false
    atomicJson(ownerFile, own)
    return true
  })
  if (!acquired) return 0
  const waiters = []
  const deadline = Date.now() + leaseMs
  try {
    for (const spool of spools) { const waiter = spool.slot('claude_asyncRewake'); if (waiter) waiters.push({ spool, waiter }) }
    for (;;) {
      for (const spool of listEndpoints({ caller: { harness: 'claude', conversation: session } })) {
        if (!waiters.some(item => item.spool.id === spool.id) && spool.read().runtime !== 'stopped') {
          const caller = spool.read().caller, original = spools[0].read().caller
          if (caller.owner.pid !== original.owner.pid || caller.owner.started !== original.owner.started) continue
          const waiter = spool.slot('claude_asyncRewake')
          if (waiter) waiters.push({ spool, waiter })
        }
      }
      const active = waiters.filter(({ spool }) => spool.read().runtime !== 'stopped' && sameProcess(spool.read().caller.owner))
      if (!active.length) return 0
      for (const { spool } of active) {
      const state = spool.read(), record = spool.claim('claude_asyncRewake')
      if (record) {
        const preview = String(record.event.body ?? '').length > PAGE_CHARS
        try {
          await spool.assertCurrentEndpoint()
          if (preview) spool.handoff(record)
          await write(renderDelivery(state, record, { preview }))
          if (!preview) spool.finish(record, { reason: 'claude_asyncRewake_output' })
        } catch (error) { spool.finish(record, { state: 'unknown', reason: 'PARENT_CLAUDE_OUTPUT_UNKNOWN' }); throw error }
        await spool.flushReceiptsAfterOutput()
        return 2
      }
      }
      if (Date.now() >= deadline) {
        const spool = active[0].spool, state = spool.read()
        await write(JSON.stringify({ schema: 'peertable.parent-control.v1', code: 'PARENT_RECEIVER_EXPIRED', endpoint_id: spool.id, rearm: { tool: 'parent_join', arguments: { project: spool.project, name: state.name } } }))
        return 2
      }
      await delay(250)
    }
  } finally {
    for (const { spool, waiter } of waiters) spool.releaseSlot(waiter, spool.read().runtime === 'stopped' ? 'stopped' : 'rearm_pending')
    for (const { spool } of waiters) await spool.publishHealth()
    withParentLock(join(slot, 'transactions'), () => {
      if (existsSync(ownerFile)) {
        const saved = readJson(ownerFile)
        if (saved.pid === own.pid && saved.started === own.started) rmSync(ownerFile)
      }
    })
  }
}
