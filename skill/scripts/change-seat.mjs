// 確定した席設定を公開APIで変更し、台帳とroom履歴を読み返す。
import { execFileSync } from 'node:child_process'
import { AitermClient } from './aiterm-client.mjs'
import { RoomApi } from './room-api.mjs'
import { seatSessionId } from './seat-session.mjs'
import { launchSeat } from './launch-seat.mjs'
import { projectPath, readSetup, runScript, fail } from './project-scaffold.mjs'
import { resolveWindowsCommand } from './platform/windows/resolve-lattice-command.mjs'

export function validateTarget(harness, model, effort, { execute = execFileSync, resolveCommand = resolveWindowsCommand } = {}) {
  const args = harness === 'claude' ? ['--help'] : harness === 'codex' ? ['debug', 'models'] : ['models']
  const invocation = resolveCommand(harness, args)
  const output = execute(invocation.command, invocation.argv, { encoding: 'utf8', timeout: 30_000 })
  if (harness === 'claude') {
    const offset = output.indexOf('--effort')
    const levels = /\(([a-z0-9, ]+)\)/u.exec(output.slice(offset, offset + 400))?.[1].split(',').map(x => x.trim())
    if (!levels) fail('SEAT_CHANGE_EFFORT_CATALOG_UNAVAILABLE', 'Claudeのeffort一覧を読めません')
    if (!levels.includes(effort)) fail('SEAT_CHANGE_EFFORT_UNSUPPORTED', effort)
  } else if (harness === 'codex') {
    const entry = JSON.parse(output).models.find(item => item.slug === model)
    if (!entry) fail('SEAT_CHANGE_MODEL_UNSUPPORTED', model)
    if (!entry.supported_reasoning_levels.some(item => item.effort === effort)) fail('SEAT_CHANGE_EFFORT_UNSUPPORTED', effort)
  } else {
    const models = [...output.matchAll(/^\s*[-*]\s+(\S+)/gmu)].map(match => match[1])
    if (!models.includes(model)) fail('SEAT_CHANGE_MODEL_UNSUPPORTED', model)
  }
}

export async function changeSeat(options, dependencies = {}) {
  const project = projectPath(options.project)
  const { name, parent = 'bell', reason = '' } = options
  if (!name || !/^[A-Za-z0-9._:-]+$/.test(name) || !/^[A-Za-z0-9._:-]+$/.test(parent)) fail('SEAT_CHANGE_ARGS_INVALID', '席名と親名が不正です')
  if (!options.model && !options.effort) fail('SEAT_CHANGE_ARGS_INVALID', '--modelまたは--effortを指定してください')
  const state = readSetup(project)
  const credential = (dependencies.runScript ?? runScript)('seat-credential.mjs', ['path', project, state.room, name])
  const api = dependencies.api ?? new RoomApi(state, { credential })
  const old = (await api.members()).find(member => member.name === name)
  if (!old?.model || !(old.harness ?? old.vendor)) fail('SEAT_CHANGE_MEMBER_METADATA_MISSING', name)
  const oldHarness = old.harness ?? old.vendor
  const harness = options.harness || oldHarness, model = options.model || old.model, effort = options.effort || old.effort
  if (!['claude', 'codex', 'grok'].includes(harness)) fail('SEAT_CHANGE_HARNESS_UNSUPPORTED', harness)
  if (harness !== oldHarness && (!options.model || !options.effort)) fail('SEAT_CHANGE_ARGS_INVALID', 'harness変更にはmodelとeffortを指定してください')
  if (!effort) fail('SEAT_CHANGE_EFFORT_UNKNOWN', 'effortを明示してください')
  if (harness === oldHarness && model === old.model && effort === old.effort) return { schema: 'peertable.seat-change.v1', status: 'unchanged', member: name }
  const aiterm = dependencies.aiterm ?? new AitermClient()
  const launch = dependencies.launchSeat ?? launchSeat
  try {
    const session = seatSessionId(old)
    if (!session) fail('SEAT_CHANGE_AITERM_SESSION_MISSING', name)
    const observed = await aiterm.observe(session)
    if (!observed.exists || observed.state === 'dead') fail('SEAT_CHANGE_SEAT_MISSING', name)
    if (observed.state !== 'idle') fail('SEAT_CHANGE_SEAT_BUSY', `${name}: ${observed.state}`)
    validateTarget(harness, model, effort, dependencies)
    if (harness === oldHarness) {
      const receipt = await aiterm.structured('agent_configure', { session_id: session,
        ...(options.model ? { model } : {}), ...(options.effort ? { reasoning_effort: effort } : {}),
      }, 'aiterm.agent-configure-result.v1')
      if (receipt.session_id !== session || (options.model && receipt.model !== model)
        || (options.effort && receipt.reasoning_effort !== effort)) fail('SEAT_CHANGE_AITERM_RESULT_MISMATCH', 'Aitermが返した変更結果が一致しません')
      await api.request('members', { method: 'POST', body: { name, harness, vendor: harness, model, effort } })
    } else {
      if (!old.roles?.length) fail('SEAT_CHANGE_ROLE_MISSING', name)
      const common = { project, name, roles: old.roles.join(','), mission: old.mission }
      try {
        await launch({ ...common, harness, model, effort, brief: '席設定を変更しました。.team/roles/member.mdと工程正本・roomログから再着任し、進行中の作業を続けてください。' })
      } catch (error) {
        const current = await aiterm.observe(session)
        if (observed.process_identity && current.exists && current.harness_alive === true
          && current.process_identity?.pid === observed.process_identity?.pid
          && current.process_identity?.started_identity === observed.process_identity?.started_identity) throw error
        // 変更後の席が起動できなかった場合だけ、元の公開設定へ一度戻す。
        try { await launch({ ...common, harness: oldHarness, model: old.model, effort: old.effort,
          brief: '席設定の変更に失敗し、旧設定へ戻しました。roomログから再着任してください。' }) }
        catch (rollback) { throw new AggregateError([error, rollback], '席設定変更と旧設定への復旧が失敗しました') }
        fail('SEAT_CHANGE_ROLLED_BACK', `変更に失敗し、旧設定へ戻しました: ${error.message}`)
      }
    }
    const after = (await api.members()).find(member => member.name === name)
    if (after?.model !== model || after.effort !== effort || (after.harness ?? after.vendor) !== harness) fail('SEAT_CHANGE_CHANGED_BUT_UNVERIFIED', '変更後の台帳が一致しません')
    const body = `[席設定変更] ${parent} が ${name} を ${harness} / ${model} / ${effort} へ変更（${harness === oldHarness ? '同一sessionを維持' : '席を再起動'}）${reason ? `。理由: ${reason}` : ''}`
    const saved = await api.request('messages', { method: 'POST', body: { from: parent, to: name, body } })
    const { messages } = await api.request('messages')
    if (!messages.some(msg => msg.seq === saved.seq && msg.from === parent && msg.to === name && msg.body === body)) fail('SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED', '変更履歴を読み返せません')
    return { schema: 'peertable.seat-change.v1', status: 'changed', member: name, harness, model, effort, seq: saved.seq }
  } finally { if (!dependencies.aiterm) await aiterm.close() }
}
