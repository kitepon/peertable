import { isParentMember } from '../../room/parent-kind.mjs'
// 状態と活動の観測はAitermが所有し、Peertableはroom表示へ対応づける。
import { seatSessionId, findSeatSession } from './seat-session.mjs'
import { combineSeatLamp } from './seat-usage.mjs'

export class SeatObserver {
  constructor(aiterm, room) {
    this.aiterm = aiterm
    this.room = room
    this.cursors = new Map()
  }
  async read(sessionId) {
    const result = await this.aiterm.observe(sessionId, this.cursors.get(sessionId))
    if (result.activity.cursor) this.cursors.set(sessionId, result.activity.cursor)
    else this.cursors.delete(sessionId)
    return result
  }
  async cycle(members, previous, observedAt) {
    const sessions = await this.aiterm.sessions(['PEERTABLE_MEMBER', 'PEERTABLE_ROOM'])
    const live = new Set(sessions.map(item => item.session_id))
    for (const id of this.cursors.keys()) if (!live.has(id)) this.cursors.delete(id)
    const result = new Map()
    const mainIds = new Set(members.map(seatSessionId).filter(Boolean))
    for (const member of members) {
      if (isParentMember(member)) continue
      const id = seatSessionId(member)
      if (!id) continue
      try { findSeatSession(member, sessions, this.room) }
      catch (error) {
        if (error.code !== 'PEERTABLE_SEAT_SESSION_IDENTITY_CONFLICT') throw error
        result.set(member.name, { error })
        continue
      }
      const raw = await this.read(id)
      const paneStatus = raw.state === 'missing' ? 'dead' : raw.state
      const prev = previous.get(member.name)
      const busySince = ['busy', 'blocked'].includes(paneStatus)
        ? (prev?.busySince ?? observedAt) : null
      const job = { alive: false, active: (raw.activity.background_cpu_delta_seconds ?? 0) > 0 }
      const jobs = sessions.filter(item => !mainIds.has(item.session_id)
        && item.environment?.PEERTABLE_MEMBER === member.name && item.environment?.PEERTABLE_ROOM === this.room)
      for (const session of jobs) {
        const work = await this.read(session.session_id)
        if (!work.exists || work.pane_alive === false) continue
        job.alive = true
        if (work.activity.output_changed === true || (work.activity.cpu_delta_seconds ?? 0) > 0) job.active = true
      }
      result.set(member.name, {
        status: combineSeatLamp(paneStatus, job), paneStatus, busySince,
        paneTokenHint: raw.token_hint, identity: raw.process_identity,
      })
    }
    return result
  }
}
