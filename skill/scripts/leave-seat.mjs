// 席の停止を公開APIで確かめてから、Peertableの登録とcredentialを撤去する。
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AitermClient } from './aiterm-client.mjs'
import { RoomApi } from './room-api.mjs'
import { findSeatSession } from './seat-session.mjs'
import { projectPath, readSetup, runScript, fail } from './project-scaffold.mjs'
import { endSeatLaunch } from './seat-launch-phase.mjs'

export async function leaveSeat(project, name, { aiterm, api, credentialCommand = runScript } = {}) {
  if (!name || !/^[A-Za-z0-9._:-]+$/.test(name)) fail('SEAT_LEAVE_ARGS_INVALID', 'member名に使えない文字があります')
  project = projectPath(project)
  const state = readSetup(project)
  const env = { ...process.env }
  delete env.PEERTABLE_POST_TOKEN
  const credential = args => credentialCommand('seat-credential.mjs', args, { env }).trim()
  let file = credential(['path', project, state.room, name])
  if (!existsSync(file)) file = credential(['prepare', project, state.room, name])
  api ??= new RoomApi(state, { credential: file })
  const ownAiterm = !aiterm
  aiterm ??= new AitermClient({ env })
  try {
    const member = (await api.members()).find(item => item.name === name)
    const sessions = await aiterm.sessions(['PEERTABLE_MEMBER', 'PEERTABLE_ROOM'])
    // 台帳が消えた直後の再実行でも、同じroomの残存席を公開環境情報で特定する。
    const session = member
      ? findSeatSession(member, sessions, state.room)
      : sessions.find(item => item.environment?.PEERTABLE_MEMBER === name && item.environment?.PEERTABLE_ROOM === state.room)
    if (session) {
      await aiterm.call('pty_close', { session_id: session.session_id })
      if ((await aiterm.sessions()).some(item => item.session_id === session.session_id)) {
        fail('SEAT_LEAVE_SESSION_FAILED', `${session.session_id} が停止後も残っています`)
      }
    }
    await api.request(`members/${encodeURIComponent(name)}`, { method: 'DELETE' })
    if ((await api.members()).some(item => item.name === name)) fail('SEAT_LEAVE_MEMBER_FAILED', `${name} の登録が残っています`)
    for (const suffix of ['.grok-home', '.codex']) rmSync(join(project, '.team', 'seats', name + suffix), { recursive: true, force: true })
    endSeatLaunch(project, name)
    credential(['remove', project, file])
    return { schema: 'peertable.seat-leave.v1', status: 'left', member: name, session_id: session?.session_id ?? null }
  } finally {
    if (ownAiterm) await aiterm.close()
  }
}
