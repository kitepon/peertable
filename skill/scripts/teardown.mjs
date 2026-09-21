// 解散はroomと履歴を残す。公開APIで席を止めてから、所有する足場を撤去する。
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { AitermClient } from './aiterm-client.mjs'
import { RoomApi } from './room-api.mjs'
import { leaveSeat } from './leave-seat.mjs'
import { projectPath, readSetup, readJson, runScript, removeExclude, fail } from './project-scaffold.mjs'
import { packageRoot } from './install-skill.mjs'
import { resolveLatticeInvocation } from './seat-usage.mjs'
import { seatSessionId } from './seat-session.mjs'

function landingReports(project, state) {
  if (state.mode !== 'lattice') return []
  const run = args => {
    const invocation = resolveLatticeInvocation(process.env.LATTICE_CLI || state.lattice_cli || 'lattice', args)
    return JSON.parse(execFileSync(invocation.command, invocation.argv, { cwd: project, encoding: 'utf8' }))
  }
  const listed = run(['run', 'list', '--json'])
  if (listed.schema !== 'lattice.run_list.v1' || !Array.isArray(listed.active_runs)) fail('PEERTABLE_LANDING_INVALID', 'run listの契約が異なります')
  return listed.active_runs.map(entry => {
    if (!entry?.run_ref) fail('PEERTABLE_LANDING_INVALID', 'run_refがありません')
    const report = run(['run', 'landing', '--run', entry.run_ref])
    if (report.schema !== 'lattice.run_landing_report.v1' || !Array.isArray(report.accepted_receipts)
      || report.accepted_receipts.some(receipt => typeof receipt.landed !== 'boolean')) fail('PEERTABLE_LANDING_INVALID', 'run landingの契約が異なります')
    return report
  })
}

export async function archiveLog(api, project, room) {
  const { messages } = await api.request('messages')
  const dir = join(project, 'docs', 'archive')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `room-log_${room}_${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  const lines = [`# 円卓ログ — room ${room}（全${messages.length}発言）`, '', '解散前の控え。roomと過去ログの原本はサーバーに残ります。', '']
  for (const msg of messages) lines.push(`## [${msg.seq}] ${msg.from} → ${msg.to_names?.join(', ') ?? msg.to} ・ ${msg.ts}`, '', msg.body ?? '（本文欠落）', '')
  writeFileSync(file, lines.join('\n'))
  return file
}

export async function teardownProject(options, dependencies = {}) {
  const project = projectPath(options.project)
  const state = readSetup(project)
  const team = join(project, '.team')
  const env = { ...process.env }
  delete env.PEERTABLE_POST_TOKEN
  const script = dependencies.runScript ?? runScript
  const credential = script('seat-credential.mjs', ['prepare', project, state.room, 'teardown'], { env })
  const api = dependencies.api ?? new RoomApi(state, { credential })
  const aiterm = dependencies.aiterm ?? new AitermClient({ env })
  const steps = []
  const errors = []
  const step = async (name, action) => {
    try { const result = await action(); steps.push({ name, status: 'done', result }); return true }
    catch (error) { errors.push(error); steps.push({ name, status: 'failed', message: error.message }); return false }
  }
  try {
    const members = await api.members()
    await aiterm.sessions()
    if (!options.purge) await step('roomログの控え', () => archiveLog(api, project, state.room))
    let stopped = true
    for (const member of members) {
      if (member.delivery?.kind === 'parent_watch' || !seatSessionId(member)) continue
      if (!await step(`席 ${member.name} の退席`, () => leaveSeat(project, member.name, { aiterm }))) stopped = false
    }
    for (const kind of ['wakeup', 'seat-status', 'alarm']) {
      const recordPath = join(team, `${kind}-bridge.json`)
      if (!existsSync(recordPath)) { steps.push({ name: `${kind}停止`, status: 'skipped', reason: '起動記録なし' }); continue }
      const record = readJson(recordPath)
      if (!await step(`${kind}停止`, async () => {
        script(`${kind}-bridge.mjs`, [project, '--stop'], { env })
        const id = record.aiterm_session_id || `peertable-${kind}-${state.room}`
        if ((await aiterm.sessions()).some(session => session.session_id === id)) await aiterm.call('pty_close', { session_id: id })
        if ((await aiterm.sessions()).some(session => session.session_id === id)) fail('PEERTABLE_RUNTIME_STOP_FAILED', `${id} が残っています`)
      })) stopped = false
    }
    await step('Lattice成果の着地確認', () => landingReports(project, state))
    // 停止できなかったruntimeの記録を残し、同じ入口から再実行できる状態を保つ。
    if (!stopped) fail('PEERTABLE_TEARDOWN_STOP_FAILED', '席またはruntimeの停止に失敗しました。.teamを残しています')
    if (errors.length) fail('PEERTABLE_TEARDOWN_INCOMPLETE', 'ログ保存または成果確認に失敗しました。再実行用の.teamを残しています')
    const roomDone = await step(options.purge ? 'room削除' : 'room解散', async () => {
      if (options.purge) {
        await api.request('', { method: 'DELETE' })
      } else {
        await api.request('messages', { method: 'POST', body: { from: 'system', to: 'system', body: `解散。この卓はここまで。参加者: ${members.map(member => member.name).join(', ')}。部屋と過去ログは残ります。` } })
        for (const member of await api.members()) await api.request(`members/${encodeURIComponent(member.name)}`, { method: 'DELETE' })
        await api.request('bridges', { method: 'DELETE' })
        await api.request('archive', { method: 'POST' })
      }
    })
    if (!roomDone) fail('PEERTABLE_TEARDOWN_ROOM_FAILED', 'roomの撤去に失敗しました。再実行用の.teamを残しています')
    if (state.external_pane) {
      if (state.project_json_preexisting) copyFileSync(join(team, 'project.json.bak'), join(project, '.lattice', 'project.json'))
      else rmSync(join(project, '.lattice', 'project.json'), { force: true })
    }
    const managed = state.room_mcp_managed ?? state.added_root_mcp ?? state.root_mcp_json_fallback ?? false
    if (managed) script('remove-managed-room-mcp.mjs', [project], { env })
    script('ensure-codex-room-mcp.mjs', ['remove', project, packageRoot], { env: { ...env, CODEX_HOME: join(project, '.codex') } })
    script('ensure-cursor-room-mcp.mjs', ['remove', project, packageRoot], { env })
    if (state.work_order_adapter && !state.runtime_preexisting) rmSync(join(project, '.lattice', 'runtime'), { recursive: true, force: true })
    if (options.purge && !state.lattice_preexisting) rmSync(join(project, '.lattice'), { recursive: true, force: true })
    for (const [flag, rule] of [['added_exclude', '.team/'], ['added_mcp_exclude', '/.mcp.json'], ['added_runtime_exclude', '/.lattice/runtime/']]) {
      if (state[flag]) removeExclude(project, rule)
    }
    rmSync(team, { recursive: true })
    steps.push({ name: 'projectの足場撤去', status: 'done' })
    const result = { schema: 'peertable.teardown-result.v1', status: errors.length ? 'incomplete' : 'done', mode: options.purge ? 'purge' : 'archive', project, steps }
    if (errors.length) throw Object.assign(new AggregateError(errors, '一部の工程に失敗しました'), { code: 'PEERTABLE_TEARDOWN_INCOMPLETE', result })
    return result
  } catch (error) {
    error.result ??= { schema: 'peertable.teardown-result.v1', status: 'incomplete', project, steps }
    throw error
  } finally { if (!dependencies.aiterm) await aiterm.close() }
}
