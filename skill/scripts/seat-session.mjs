// 既存台帳のtargetは移行時の識別子として読むだけで、backendへ渡さない。
export function seatSessionId(member) {
  return member.aiterm_session_id || member.observe?.aiterm_session_id || member.observe?.tmux_target || null
}

export function findSeatSession(member, sessions, room) {
  const id = seatSessionId(member)
  const session = id ? sessions.find(item => item.session_id === id) : null
  if (!session) return null
  const env = session.environment ?? {}
  if ((env.PEERTABLE_MEMBER && env.PEERTABLE_MEMBER !== member.name) || (env.PEERTABLE_ROOM && env.PEERTABLE_ROOM !== room)) {
    throw Object.assign(new Error(`席 ${member.name} のAitermセッションが対象roomの本人だと確認できません`), {
      code: 'PEERTABLE_SEAT_SESSION_IDENTITY_CONFLICT',
    })
  }
  return session
}
