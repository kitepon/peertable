// setup/resumeは、対象projectの生成物更新とruntimeの確認までを連続して行う。
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { AitermClient } from './aiterm-client.mjs'
import { RoomApi } from './room-api.mjs'
import { findSeatSession, seatSessionId } from './seat-session.mjs'
import { scaffoldProject, ensureProjectRoomMcp, projectPath, readSetup, runScript, writeJson, fail } from './project-scaffold.mjs'
import { ensureProjectRuntime } from './ensure-project-runtime.mjs'
import { ensureCursorRoomMcp } from './ensure-cursor-room-mcp.mjs'
import { packageRoot } from './install-skill.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const targets = members => members.filter(member => member.delivery?.kind !== 'parent_watch' && (member.harness ?? member.vendor) && seatSessionId(member))

export async function seatsToResume(aiterm, members, sessions, room) {
  const relaunch = []
  for (const member of members) {
    if (member.delivery?.kind === 'parent_watch' || !(member.harness ?? member.vendor)) continue
    const session = findSeatSession(member, sessions, room)
    if (session) {
      const observation = await aiterm.observe(session.session_id)
      if (observation.harness_alive === true && !['dead', 'missing'].includes(observation.state)) continue
      if (observation.exists && observation.harness_alive !== false && !['dead', 'missing'].includes(observation.state)) {
        fail('RESUME_MEMBER_OBSERVATION_UNKNOWN', `${member.name}: ${observation.reason}`)
      }
    }
    if (!member.roles?.length) fail('RESUME_MEMBER_ROLES_MISSING', `${member.name} の役割がありません`)
    relaunch.push(member)
  }
  return relaunch
}

export async function verifyProjectRuntime(api, { probe = true, heartbeatTimeout = 90_000, probeTimeout = 120_000 } = {}) {
  let members
  const deadline = Date.now() + heartbeatTimeout
  for (;;) {
    members = targets(await api.members())
    const pending = members.filter(member => member.status_reason !== 'fresh')
    if (!pending.length) break
    if (Date.now() >= deadline) fail('RESUME_HEARTBEAT_STALE', pending.map(member => `${member.name}(${member.status_reason})`).join(', '))
    await delay(3000)
  }
  if (!probe || !members.length) return { heartbeat: members.length, probe: probe ? 'no_targets' : 'disabled' }
  const names = members.map(member => member.name)
  const saved = await api.request('messages', { method: 'POST', body: {
    from: 'resume', to: names.length === 1 ? names[0] : names,
    body: '[resume-probe] 配達経路の確認。応答不要・読み流してよい。',
  } })
  const probeDeadline = Date.now() + probeTimeout
  for (;;) {
    const { delivery } = await api.request(`deliveries?seq=${saved.seq}`)
    const pending = names.filter(name => delivery?.[name]?.state !== 'delivered')
    if (!pending.length) return { heartbeat: members.length, probe: 'delivered', seq: saved.seq }
    if (Date.now() >= probeDeadline) fail('RESUME_PROBE_UNDELIVERED', pending.map(name => `${name}=${delivery?.[name]?.state ?? 'unknown'}`).join(', '))
    await delay(3000)
  }
}

export async function setupProject(options) {
  const project = projectPath(options.project)
  const aiterm = new AitermClient()
  try {
    // 公開依存の不足は、projectへ生成物を置く前に明示する。
    await aiterm.sessions()
    const scaffold = scaffoldProject({ ...options, project })
    if (scaffold.action === 'resume') return await resumeProject({ ...options, project }, { aiterm })
    const runtime = await ensureProjectRuntime(project, { aiterm })
    return { schema: 'peertable.setup-result.v1', status: 'ready', project, room: readSetup(project).room, runtime }
  } finally { await aiterm.close() }
}

export async function resumeProject(options, dependencies = {}) {
  const project = projectPath(options.project)
  let state = readSetup(project)
  const aiterm = dependencies.aiterm ?? new AitermClient()
  try {
    const sessions = await aiterm.sessions(['PEERTABLE_MEMBER', 'PEERTABLE_ROOM'])
    const script = dependencies.runScript ?? runScript
    const credential = script('seat-credential.mjs', ['prepare', project, state.room, 'runtime'])
    const api = dependencies.api ?? new RoomApi(state, { credential })
    const members = await api.members()
    const relaunch = await seatsToResume(aiterm, members, sessions, state.room)
    ensureProjectRoomMcp(project, state)
    if (existsSync(join(project, '.team', 'cursor-room-mcp.managed.json'))
        || members.some(member => (member.harness ?? member.vendor) === 'cursor'))
      ensureCursorRoomMcp(project, packageRoot)
    if (options.plan) {
      state = { ...state, mode: 'lattice', plan_key: options.plan, phases: options.phases ?? [] }
      writeJson(join(project, '.team', 'setup-state.json'), state)
      script('external-pane.mjs', [project, state.room, process.env.PEERTABLE_PUBLIC_URL || state.public_url || state.server_url])
    }
    script('upgrade-team-assets.mjs', [project])
    for (const member of relaunch) {
      const { launchSeat } = await import('./launch-seat.mjs')
      await launchSeat({ project, name: member.name, roles: member.roles.join(','), harness: member.harness ?? member.vendor,
        model: member.model, effort: member.effort, mission: member.mission })
    }
    const runtime = await (dependencies.ensureProjectRuntime ?? ensureProjectRuntime)(project, { aiterm, env: { ...process.env, PEERTABLE_CREDENTIAL_FILE: credential } })
    const verified = await verifyProjectRuntime(api, { probe: options.probe !== false })
    return { schema: 'peertable.resume-result.v1', status: 'ready', project, room: state.room, relaunched: relaunch.map(member => member.name), runtime, verified }
  } finally { if (!dependencies.aiterm) await aiterm.close() }
}
