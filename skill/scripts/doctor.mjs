// 診断はPeertableの記録とAitermの公開観測を照合する。repairはbridgeだけを直す。
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { AitermClient } from './aiterm-client.mjs'
import { RoomApi } from './room-api.mjs'
import { seatSessionId } from './seat-session.mjs'
import { bridgeRecordLive } from './bridge-record-live.mjs'
import { ensureBridge } from './ensure-project-runtime.mjs'
import { projectPath, readSetup, readJson } from './project-scaffold.mjs'
import { resolveLatticeInvocation } from './seat-usage.mjs'

export async function diagnoseProject(options) {
  const project = projectPath(options.project)
  const state = readSetup(project)
  const api = new RoomApi(state)
  const aiterm = new AitermClient()
  const checks = []
  const check = async (name, action) => {
    try { const result = await action(); checks.push({ name, status: 'ok', ...result }); return result }
    catch (error) { checks.push({ name, status: 'failed', message: error.message }); return null }
  }
  try {
    await check('room到達', () => api.request('summary'))
    const listed = await check('member台帳', async () => ({ members: await api.members() }))
    await check('Aitermと預け仕事の公開観測', async () => ({ sessions: (await aiterm.sessions(['PEERTABLE_MEMBER', 'PEERTABLE_ROOM'])).length }))
    for (const member of listed?.members ?? []) {
      if (member.delivery?.kind === 'parent_watch' || !seatSessionId(member)) continue
      await check(`席 ${member.name}`, async () => {
        if (!member.roles?.length || !member.model || !member.pid || !member.started_identity || !member.argv_digest) throw new Error('台帳の素性・本人性が不完全です')
        const observed = await aiterm.observe(seatSessionId(member))
        if (!observed.exists || observed.state === 'dead') throw new Error('席が停止しています。peertable resumeで再開してください')
        const identity = observed.process_identity
        if (!identity || identity.pid !== member.pid || identity.started_identity !== member.started_identity || identity.argv_digest !== member.argv_digest) throw new Error('台帳と現在のプロセス本人性が一致しません')
        return { state: observed.state, session_id: observed.session_id }
      })
    }
    for (const kind of ['alarm', 'seat-status', 'wakeup']) await check(`${kind} bridge`, async () => {
      const path = join(project, '.team', `${kind}-bridge.json`)
      const live = () => existsSync(path) && bridgeRecordLive(readJson(path))
      let repaired = false
      if (!live() && options.repair) { await ensureBridge(project, kind, { aiterm }); repaired = true }
      if (!live()) throw new Error('起動記録が無いか、process・進捗が停止しています')
      return { repaired, pid: readJson(path).pid }
    })
    checks.push({ name: '読了ack', status: (listed?.members ?? []).some(member => member.read_seq !== undefined) ? 'ok' : 'unknown', reason: 'memberのread_seqで判定' })
    if (state.mode === 'lattice') await check('Lattice工程', async () => {
      const invocation = resolveLatticeInvocation(process.env.LATTICE_CLI || state.lattice_cli || 'lattice', ['status', '--json'])
      return JSON.parse(execFileSync(invocation.command, invocation.argv, { cwd: project, encoding: 'utf8' }))
    })
    return { schema: 'peertable.diagnostics.v1', status: checks.some(item => item.status === 'failed') ? 'failed' : 'ready', project, room: state.room, checks }
  } finally { await aiterm.close() }
}
