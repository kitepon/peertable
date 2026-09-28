// 公式CLI・公式queue・専用project hookで追加scenarioを動かす。fixtureの記録だけでは合格にしない。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { execFileSync } from 'node:child_process'
import { createScenarioContext } from './scenarios-context.mjs'
import { createNativeFixtureFactory, waitOwnedFixtureExit } from './scenarios-fixtures.mjs'
import { sha256 } from './evidence.mjs'
import { createBackgroundSurfaceAdapters } from './scenarios-surfaces.mjs'

const fail = (code, message, detail) => { throw Object.assign(new Error(message), { code, detail }) }
const rows = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const nativeSession = event => event.session_id ?? event.conversation_id ?? event.sessionId
const nativeTurn = event => event.turn_id ?? event.prompt_id ?? event.tool_use_id ?? event.toolUseId
const hookOutput = row => Boolean(row.stdout?.trim() && row.stdout.trim() !== '{}') || Boolean(row.stderr?.trim())
const sourceUnconfirmed = (harness, boundary, detail) => fail('ACCEPTANCE_OFFICIAL_BOUNDARY_UNCONFIRMED', `${harness}: ${boundary}の公式境界を確認できません`, detail)

const processTree = () => {
  if (process.platform === 'win32') {
    const parsed = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' }))
    return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId }))
  }
  return execFileSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => { const [pid, parent] = line.trim().split(/\s+/u).map(Number); return { pid, parent } })
}

// 製品watcherから起動した公式app-serverだけ。runnerの別RPC接続を更新証拠へ混ぜない。
export function monitorQueueConnections({ watcher, executable, processIdentity, sameProcess, artifact, interval = process.platform === 'win32' ? 100 : 20 }) {
  const monitor = { canceled: false, connections: [], error: null }
  monitor.promise = (async () => {
    while (!monitor.canceled) {
      if (!sameProcess(watcher)) fail('ACCEPTANCE_QUEUE_WATCHER_GONE', '接続観測中に専用watcherが終了しました')
      const tree = processTree(), descendants = new Set([watcher.pid]); let added = true
      while (added) { added = false; for (const row of tree) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); added = true } }
      for (const pid of descendants) {
        if (pid === watcher.pid) continue
        const previous = monitor.connections.find(connection => connection.owner.pid === pid && !connection.closed_at)
        if (previous) { if (sameProcess(previous.owner)) previous.last_seen_at = new Date().toISOString(); else previous.closed_at = new Date().toISOString(); continue }
        const owner = processIdentity(pid)
        if (!owner || owner.executable !== executable || !/app-server\s+--listen\s+stdio:\/\//u.test(owner.command)) continue
        let current = monitor.connections.find(connection => connection.owner.pid === pid && connection.owner.started === owner.started)
        if (!current) { current = { owner, watcher, first_seen_at: new Date().toISOString(), last_seen_at: null, closed_at: null }; monitor.connections.push(current) }
        current.last_seen_at = new Date().toISOString()
      }
      for (const connection of monitor.connections) if (!connection.closed_at && !sameProcess(connection.owner)) connection.closed_at = new Date().toISOString()
      if (artifact) writeFileSync(artifact, JSON.stringify({ source: 'os_process', connections: monitor.connections }, null, 2))
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  })().catch(error => { monitor.error = error })
  monitor.close = async () => { monitor.canceled = true; await monitor.promise; if (monitor.error) throw monitor.error }
  return monitor
}

export function queueConnectionProof(connections, checks) {
  const bound = checks.map(check => {
    if (!check.receipt.queued_submission_id || !check.receipt.accepted_at) fail('ACCEPTANCE_QUEUE_ACCEPTANCE_MISSING', '公式queue受付がありません')
    const at = Date.parse(check.receipt.accepted_at)
    const candidates = connections.filter(connection => Date.parse(connection.first_seen_at) <= at && connection.closed_at && Date.parse(connection.closed_at) >= at)
    if (candidates.length !== 1) fail('ACCEPTANCE_QUEUE_CONNECTION_UNBOUND', '公式受付時点の存命app-serverが1個に確定しません')
    return { seq: check.original.seq, queued_submission_id: check.receipt.queued_submission_id, accepted_at: check.receipt.accepted_at, connection: candidates[0] }
  })
  if (bound.length < 2 || new Set(bound.map(item => `${item.connection.owner.pid}:${item.connection.owner.started}`)).size < 2) fail('ACCEPTANCE_QUEUE_CONNECTION_NOT_UPDATED', '複数配送で新しい公式接続を確認できません')
  return bound
}

// 公式MCP包装のJSONだけを開き、本文の正規化や自由文からのerror推測をしない。
export function productToolError(value, expected) {
  if (typeof value === 'string') { try { return productToolError(JSON.parse(value), expected) } catch (error) { if (error instanceof SyntaxError) return null; throw error } }
  if (!value || typeof value !== 'object') return null
  if (value.schema === 'peertable.parent-error.v1') return value.state === 'failed' && value.error_code === expected ? value : null
  if (value.structuredContent) return productToolError(value.structuredContent, expected)
  for (const part of value.content ?? []) if (part.type === 'text') { const found = productToolError(part.text, expected); if (found) return found }
  return null
}

// callbackで判定を置換しない。実hookの同eventを実process 2個以上が受け、本文出力が1個であることを照合する。
export function competitorProof(events, { session, delivery, minimum = 2, compatibility = false }) {
  const groups = new Map()
  for (const row of events) {
    if (row.phase !== 'started' || nativeSession(row.event) !== session || row.event.turn_id && row.event.turn_id !== delivery.turn_id) continue
    const key = sha256(JSON.stringify(row.event))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const group = [...groups.values()].find(starts => new Set(starts.map(row => row.pid)).size >= minimum && starts.every(start => events.some(row => row.phase === 'completed' && row.pid === start.pid && isDeepStrictEqual(row.event, start.event))))
  if (!group) fail('ACCEPTANCE_HOOK_COMPETITION_NOT_OBSERVED', '同じ実eventの競合processと完了が揃いません')
  const started = group
  const completed = events.filter(row => row.phase === 'completed' && started.some(start => start.pid === row.pid && isDeepStrictEqual(start.event, row.event)))
  if (new Set(completed.map(row => row.pid)).size !== completed.length || completed.length !== started.length) fail('ACCEPTANCE_HOOK_COMPETITION_NOT_OBSERVED', '同じprocessの完了重複があります')

  if (compatibility) {
    if (completed.some(row => row.code !== 0 || hookOutput(row))) fail('ACCEPTANCE_COMPATIBILITY_DUPLICATE', '別harnessの互換hookが相関または本文を出力しました')
  } else if (completed.filter(hookOutput).length > 1) fail('ACCEPTANCE_CLAIM_OUTPUT_DUPLICATED', '競合hookが複数の本文を出力しました')
  return { starts: started, completions: completed, competitor_outputs: completed.filter(hookOutput).length }
}

export function verifyRelatedIsolation({ primary, secondary, checks, messages }) {
  if (primary.meta.parent_session === secondary.meta.parent_session || primary.spool.id === secondary.spool.id || primary.meta.room === secondary.meta.room) fail('ACCEPTANCE_PARALLEL_IDENTITY', 'room・会話・endpointが独立していません')
  for (const check of checks) {
    const target = check.parent_session === primary.meta.parent_session ? primary : secondary
    const other = target === primary ? secondary : primary
    if (check.original.room !== target.meta.room || !messages[target.meta.room].some(message => message.seq === check.original.seq && message.body === check.original.body)) fail('ACCEPTANCE_PARALLEL_SOURCE', 'roomの原文が不一致です')
    if (other.observe().deliveries.some(delivery => delivery.delivery_id === check.delivery.delivery_id || delivery.body === check.original.body)) fail('ACCEPTANCE_PARALLEL_CROSS_DELIVERY', '別room/会話へ誤流入しました')
  }
  return { primary: { room: primary.meta.room, session: primary.meta.parent_session, endpoint: primary.spool.id }, secondary: { room: secondary.meta.room, session: secondary.meta.parent_session, endpoint: secondary.spool.id } }
}

// OS適合はここだけ。対象PID+開始identityを毎回照合し、native親自身や共有受信を停止しない。
export async function pauseOwnedReceiver(owner, { parent, sameProcess, processDescendsFrom, paused, resume = false }) {
  if (!owner || !sameProcess(owner) || owner.pid === parent.pid || !processDescendsFrom(owner, parent)) fail('ACCEPTANCE_PROCESS_FAULT_OWNER', '専用親の受信processではありません')
  if (process.platform !== 'win32') process.kill(owner.pid, resume ? 'SIGCONT' : 'SIGSTOP')
  else {
    // Windows公式thread API。列挙するのは検証済みown PIDのthreadだけ。
    const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PeertableOwnThreads{[DllImport("kernel32.dll")]public static extern IntPtr OpenThread(uint a,bool b,uint c);[DllImport("kernel32.dll")]public static extern uint SuspendThread(IntPtr h);[DllImport("kernel32.dll")]public static extern uint ResumeThread(IntPtr h);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}';$p=Get-Process -Id ${owner.pid};foreach($t in $p.Threads){$h=[PeertableOwnThreads]::OpenThread(2,$false,$t.Id);if($h -eq [IntPtr]::Zero){throw 'own thread open failed'};try{$r=[PeertableOwnThreads]::${resume ? 'ResumeThread' : 'SuspendThread'}($h);if($r -eq 4294967295){throw 'own thread control failed'}}finally{[void][PeertableOwnThreads]::CloseHandle($h)}}`
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' })
  }
  if (resume) paused.delete(owner.pid); else paused.set(owner.pid, owner)
  if (!sameProcess(owner)) fail('ACCEPTANCE_PROCESS_FAULT_DISAPPEARED', '一時停止/再開の対象が終了しました')
  return { owner, operation: resume ? 'resume' : 'suspend', at: new Date().toISOString() }
}

// 残る境界を呼出し側の任意callbackへ押し出さず、このmodule内の公式操作に固定する。
export function createNativeActions({ factory, primary, lifecycle = null }) {
  const saved = new Map(), paused = new Map(), ownedFixtures = new Set([primary])
  const self = s => s.context.endpoint('self')
  const fixtureFor = target => { if (!target.fixture || !ownedFixtures.has(target.fixture)) fail('ACCEPTANCE_FIXTURE_OWNER_MISSING', 'scenario専用親であることを確認できません'); return target.fixture }
  const state = s => saved.get(s.runId) ?? (() => { const value = {}; saved.set(s.runId, value); return value })()
  const observerRows = fixture => rows(fixture.observer?.observations)
  const hookObservation = (s, expectation, detail) => s.result(s, expectation, 'official_hook', detail)
  const join = async (s, alias = 'self') => { const target = s.context.endpoint(alias), fixture = fixtureFor(target); await fixture.join(); return fixture.target }
  const recordPending = s => s.pending.filter(item => item.scope.runId === s.runId && item.scope.scenario === s.scenario)
  const confirmOne = s => { const last = s.checks.at(-1); if (!last || last.count !== 1 || last.status !== 'passed') fail('ACCEPTANCE_NATIVE_DELIVERY_MISSING', s.scenario); return last }
  const actions = {}

  if (['cursor', 'grok'].includes(primary.harness)) {
    actions.work_start = async (_, s) => {
      const target = self(s), fixture = fixtureFor(target)
      const script = s.artifactFor(s, 'work-process.mjs'), identity = s.artifactFor(s, 'work-start.json'), release = s.artifactFor(s, 'work-release.json'), completed = s.artifactFor(s, 'work-completed.json'), nonce = `PEERTABLE_WORK_${randomUUID()}`
      writeFileSync(script, `import {writeFileSync,existsSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({pid:process.pid}));while(!existsSync(process.argv[3]))await new Promise(r=>setTimeout(r,100));writeFileSync(process.argv[4],JSON.stringify({pid:process.pid}));console.log(process.argv[5]);\n`)
      const command = s.shellCommand(process.execPath, [script, identity, release, completed, nonce]), before = target.observe().rows
      state(s).work = { fixture, identity, release, completed, nonce, before }
      const input = s.harness === 'cursor' ? { command, cwd: fixture.project } : { command, description: '配送中も継続する専用受入作業', background: true, timeout: 0 }
      await fixture.submit(`作業継続の実機受入です。${s.harness === 'cursor' ? 'Shell' : 'run_terminal_command'}へ次の完成済み入力を渡してください。専用processを停止せず、room符号の報告後も作業を維持してください。runnerが解除した後に公式taskの全量出力を読んで、完了符号${nonce}を報告してください。input: ${JSON.stringify(input)}`)
      const observed = await s.until('専用作業processと公式taskの相関', () => {
        if (!existsSync(identity)) return null
        const owner = s.processIdentity(JSON.parse(readFileSync(identity, 'utf8')).pid), seen = target.observe()
        if (!owner || !s.sameProcess(owner) || !s.processDescendsFrom(owner, target.meta.parent_process) || existsSync(completed)) fail('ACCEPTANCE_WORK_NATIVE_OWNER', '専用親の存命作業processではありません')
        const use = seen.toolUses.find(use => use.order >= before && use.name === (s.harness === 'cursor' ? 'Shell' : 'run_terminal_command') && isDeepStrictEqual(use.input, input))
        if (!use?.turn_id) return null
        const task = (seen.tasks ?? []).find(task => task.tool_use_id === use.id && task.pid && (task.pid === owner.pid || s.processDescendsFrom(owner, s.processIdentity(task.pid))))
        return task ? { owner, use, task } : null
      }, 120000, 100)
      Object.assign(state(s).work, observed)
      return s.result(s, 'work_running', 'native_task', { work_process: observed.owner, work_native_task: observed.task, work_tool_use_id: observed.use.id, work_turn_id: observed.use.turn_id, work_input: input })
    }
    actions.work_finish = async (_, s) => {
      const work = state(s).work, target = self(s), check = confirmOne(s)
      if (!work?.owner || !s.sameProcess(work.owner) || existsSync(work.completed) || check.delivery.order < work.before) fail('ACCEPTANCE_WORK_NOT_CONTINUED', '配送中に元作業を継続していません')
      const held = s.processIdentity(work.owner.pid)
      writeFileSync(work.release, '{}')
      await s.until('元作業processの正常終了', () => existsSync(work.completed) && !s.sameProcess(work.owner), 30000, 100)
      const completion = await s.until('元taskの公式全量readerと完了応答', () => {
        const seen = target.observe(), taskId = String(work.task.id ?? work.task.task_id)
        const reader = seen.toolUses.find(use => use.order > check.delivery.order && (s.harness === 'cursor' ? use.name === 'Read' && use.input?.path === work.fixture.adapter.nativeTaskOutputPath(taskId) && !Object.hasOwn(use.input, 'offset') && !Object.hasOwn(use.input, 'limit') : use.name === 'get_command_or_subagent_output' && isDeepStrictEqual(use.input, { task_ids: [taskId] })) && JSON.stringify(use.output ?? '').includes(work.nonce))
        const reply = reader && seen.replies.find(reply => reply.order > (reader.output_order ?? reader.order) && reply.text.includes(work.nonce) && reply.session === target.meta.parent_session)
        return reply ? { reader, reply } : null
      }, 120000, 100)
      return s.result(s, 'work_continued', 'harness_transcript', { live_at_delivery: held, work_native_task: work.task, work_start_turn: work.use.turn_id, delivery_turn: check.delivery.turn_id, completion_reader_id: completion.reader.id, work_reply_turn: completion.reply.turn_id, completion_artifact: work.completed })
    }
  }

  actions.final_arm = async (_, s) => {
    const fixture = fixtureFor(self(s)); if (!fixture.observer) sourceUnconfirmed(s.harness, '終了event observer')
    const release = s.artifactFor(s, 'final-release'), nonce = `FINAL_${randomUUID()}`
    writeFileSync(fixture.observer.controls, JSON.stringify({ hold: true, release }))
    const before = observerRows(fixture).length
    state(s).final = { fixture, release, before, nonce }
    await fixture.submit(`最終応答と終了境界の試験です。toolを追加せず、符号${nonce}を含む短い最終応答をしてください。`)
    const event = await s.until('実Stop hookの到着', () => observerRows(fixture).slice(before).find(row => row.event.hook_event_name === 'Stop' && nativeSession(row.event) === self(s).meta.parent_session), 120000, 50)
    if (!s.sameProcess(s.processIdentity(event.pid))) fail('ACCEPTANCE_FINAL_HOOK_NOT_LIVE', '公式Stopの実processがありません')
    state(s).final.event = event
    // 専用observerは同時起動した所有hookを妨げない。配送を挟んで終了するraceを作る。
    const monitor = { canceled: false, arrival: null }
    monitor.promise = (async () => {
      await s.until('終了境界での専用本文到着', () => {
        if (monitor.canceled) return true
        const posted = recordPending(s).find(item => item.posted.label === '終了境界')?.posted
        const record = posted && s.recordFor(posted)
        if (!record) return null
        const owner = s.processIdentity(event.pid)
        if (!owner || !s.sameProcess(owner)) fail('ACCEPTANCE_FINAL_BEFORE_ARRIVAL', '専用本文到着前に終了hookが完了しました')
        monitor.arrival = { seq: posted.seq, delivery_id: record.delivery_id, owner, record_state: record.state, at: new Date().toISOString() }
        writeFileSync(release, '{}'); return true
      }, 60000, 10)
    })().catch(error => { monitor.error = error; writeFileSync(release, '{}') })
    state(s).final.monitor = monitor
    return hookObservation(s, 'final_boundary_armed', { event, official_event_file: fixture.observer.observations })
  }
  actions.final_observe = async (_, s) => {
    const final = state(s).final, delivered = confirmOne(s)
    await final.monitor.promise
    if (final.monitor.error) throw final.monitor.error
    if (!final.monitor.arrival || final.monitor.arrival.seq !== delivered.original.seq) fail('ACCEPTANCE_FINAL_NATIVE_RACE_MISSING', '同じ専用本文の終了境界到着を確認できません')
    await s.until('終了境界observerの完了', () => !s.sameProcess(s.processIdentity(final.event.pid)), 30000, 100)
    const replies = self(s).observe().replies.filter(reply => reply.order > delivered.delivery.order && reply.text.includes(delivered.nonce))
    if (replies.length !== 1) fail('ACCEPTANCE_FINAL_DUPLICATE_OR_LOST', '終了競合後の実応答が欠落または重複しました')
    return hookObservation(s, 'final_no_loss_duplicate', { final_event: final.event, arrival: final.monitor.arrival, delivery_turn: delivered.delivery.turn_id, reply_turn: replies[0].turn_id, event_artifact: final.fixture.observer.observations })
  }

  for (const prefix of ['claim_race', 'slot_race']) {
    actions[`${prefix}_arm`] = async (_, s) => {
      const fixture = fixtureFor(self(s)); if (!fixture.competitors || fixture.competitors.count < 2) sourceUnconfirmed(s.harness, '同eventの競合登録')
      state(s)[prefix] = { before: rows(fixture.competitors.rows).length, fixture, slot: self(s).spool.read().waiter }
      return hookObservation(s, prefix === 'claim_race' ? 'own_claim_competitors' : 'own_simultaneous_hooks', { config_file: fixture.competitors.file, commands: fixture.competitors.commands, competing_hooks: fixture.competitors.count })
    }
    actions[`${prefix}_observe`] = async (_, s) => {
      const own = state(s)[prefix], check = confirmOne(s)
      const proof = await s.until('同eventの競合hook完了', () => {
        const events = rows(own.fixture.competitors.rows).slice(own.before)
        try { return competitorProof(events, { session: self(s).meta.parent_session, delivery: check.delivery }) } catch (error) { if (error.code === 'ACCEPTANCE_HOOK_COMPETITION_NOT_OBSERVED') return null; throw error }
      }, 120000, 100)
      const record = s.recordFor({ seq: check.original.seq })
      if (!record.claim?.id || (s.harness === 'codex' && (!record.hook_claim?.id || record.hook_state !== 'output_complete'))) fail('ACCEPTANCE_CLAIM_OWNER_MISSING', '実出力の所有claimがありません')
      const waiter = self(s).spool.read().waiter
      if (prefix === 'slot_race' && s.harness !== 'codex' && (!waiter || !s.sameProcess(waiter.owner))) fail('ACCEPTANCE_SINGLE_LIVE_SLOT_MISSING', '次受信の存命slotがありません')
      return hookObservation(s, prefix === 'claim_race' ? 'single_claim_output' : 'single_live_slot', { proof, claim_id: record.claim.id, hook_claim_id: record.hook_claim?.id, waiter, event_artifact: own.fixture.competitors.rows })
    }
  }

  actions.compatibility_arm = async (_, s) => {
    const fixture = fixtureFor(self(s)); if (!fixture.competitors?.compatibilityHarness) sourceUnconfirmed(s.harness, '別harness互換hook')
    state(s).compatibility = { before: rows(fixture.competitors.rows).length, fixture }
    return hookObservation(s, 'own_compatible_hook_loaded', { config_file: fixture.competitors.file, commands: fixture.competitors.commands, compatibility_harness: fixture.competitors.compatibilityHarness })
  }
  actions.compatibility_observe = async (_, s) => {
    const own = state(s).compatibility, check = confirmOne(s)
    const events = rows(own.fixture.competitors.rows).slice(own.before)
    const proof = competitorProof(events, { session: self(s).meta.parent_session, delivery: check.delivery, minimum: 1, compatibility: true })
    return hookObservation(s, 'one_adapter_one_binding', { proof, endpoint_id: self(s).spool.id, actual_claim: s.recordFor({ seq: check.original.seq }).claim, event_artifact: own.fixture.competitors.rows })
  }

  actions.session_clear = async (_, s) => {
    const old = self(s), fixture = fixtureFor(old), before = observerRows(fixture).length
    s.context.registerEndpoint('old', old)
    const command = s.harness === 'claude' ? '/clear' : s.harness === 'codex' ? '/new' : fixture.adapter.clear
    if (!command) sourceUnconfirmed(s.harness, '公式新会話command')
    await fixture.submit(command)
    const next = await s.until('公式SessionStartの新CID', () => observerRows(fixture).slice(before).find(row => ['SessionStart', 'sessionStart'].includes(row.event.hook_event_name) && nativeSession(row.event) && nativeSession(row.event) !== old.meta.parent_session), 60000)
    state(s).session = { old, fixture, clear: next, newSession: nativeSession(next.event) }
    return hookObservation(s, 'new_conversation_identity', { old_session: old.meta.parent_session, related_session: nativeSession(next.event), clear_event: next, event_artifact: fixture.observer.observations })
  }
  actions.session_new_join = async (_, s) => {
    const change = state(s).session, target = await change.fixture.join(change.old.spool.id)
    if (target.meta.parent_session !== change.newSession || target.spool.id === change.old.spool.id) fail('ACCEPTANCE_SESSION_NEW_BINDING', 'clear後のCIDと実joinが一致しません')
    s.context.registerEndpoint('new', target)
    return hookObservation(s, 'new_binding_verified', { related_session: target.meta.parent_session, endpoint_id: target.spool.id, original_endpoint: change.old.spool.id })
  }
  actions.session_resume = async (_, s) => {
    const change = state(s).session, current = s.context.endpoint('new')
    await change.fixture.stop()
    await change.fixture.launch({ resume: change.old.meta.parent_session })
    const resumed = await change.fixture.join()
    if (resumed.meta.parent_session !== change.old.meta.parent_session) fail('ACCEPTANCE_RESUME_CID', '公式resumeが旧CIDを返しません')
    s.context.registerEndpoint('resumed', resumed)
    return s.result(s, 'official_resume_identity', 'harness_transcript', { resumed_session: resumed.meta.parent_session, ended_session: current.meta.parent_session, old_endpoint: change.old.spool.id, resumed_endpoint: resumed.spool.id })
  }
  actions.session_isolation_observe = async (_, s) => {
    const change = state(s).session, next = s.context.endpoint('new'), oldPosts = recordPending(s).filter(item => item.posted.target === 'old')
    if (!oldPosts.length) fail('ACCEPTANCE_OLD_SESSION_SOURCE_MISSING', '旧宛専用投稿がありません')
    for (const { posted } of oldPosts) {
      if (next.observe().deliveries.some(row => row.body === posted.body || row.delivery_id === s.recordFor(posted)?.delivery_id) || next.observe().replies.some(row => row.text.includes(posted.nonce))) fail('ACCEPTANCE_OLD_BODY_NEW_SESSION', '旧本文が新会話へ誤流入しました')
      const record = s.recordFor(posted)
      if (record?.event.body !== posted.body) fail('ACCEPTANCE_OLD_BODY_LOST', '旧endpointの原文が保持されていません')
    }
    return s.result(s, 'old_body_no_new_conversation', 'harness_transcript', { original_session: change.old.meta.parent_session, related_session: next.meta.parent_session, old_seqs: oldPosts.map(item => item.posted.seq), related_transcript: next.file })
  }

  actions.parallel_open = async (_, s) => {
    const room = `parent-parallel-${randomUUID()}`
    await factory.api(room)('members', { name: 'probe', harness: 'codex' })
    const fixture = await factory.open({ harness: s.harness, room, name: `parallel-${randomUUID().slice(0, 8)}` }); ownedFixtures.add(fixture)
    const parallel = s.context.registerEndpoint('parallel', fixture.target)
    if (parallel.meta.parent_session === self(s).meta.parent_session || fixture.pkg !== s.pkg) fail('ACCEPTANCE_PARALLEL_FIXTURE', '別会話と共通導入物を確認できません')
    state(s).parallel = fixture
    return s.result(s, 'two_rooms_two_native_conversations', 'harness_transcript', { first_room: self(s).meta.room, second_room: room, first_endpoint: self(s).spool.id, second_endpoint: parallel.spool.id, related_session: parallel.meta.parent_session, related_transcript: parallel.file })
  }
  actions.parallel_observe = async (_, s) => {
    const first = self(s), second = s.context.endpoint('parallel')
    const messages = { [first.meta.room]: (await first.api('messages')).messages, [second.meta.room]: (await second.api('messages')).messages }
    const proof = verifyRelatedIsolation({ primary: first, secondary: second, checks: s.checks, messages })
    const records = [first, second].map(target => target.spool.read().records.filter(record => record.event.seq > 0))
    if (records[0].some(record => records[1].some(other => other.claim?.id && other.claim.id === record.claim?.id))) fail('ACCEPTANCE_PARALLEL_CLAIM_SHARED', '別roomが同claimを共有しました')
    return s.result(s, 'claims_room_conversation_separated', 'harness_transcript', { ...proof, related_session: second.meta.parent_session, related_transcript: second.file, first_claims: records[0].map(record => record.claim?.id), second_claims: records[1].map(record => record.claim?.id) })
  }

  actions.receiver_suspend = async (_, s) => {
    const target = self(s), fixture = fixtureFor(target), current = target.spool.read()
    const owner = s.harness === 'codex' ? current.watcher : current.waiter?.owner
    // Codexはsourceとqueueが同watcher。readyが保存された実境界で停止する専用monitorを使う。
    if (s.harness === 'codex') {
      const monitor = { canceled: false, owner, before: current.records.length, suspended: null }
      monitor.promise = (async () => {
        for (;;) {
          if (monitor.canceled) return
          const ready = target.spool.read().records.find((record, index) => index >= monitor.before && record.state === 'ready' && record.event.seq > 0)
          if (ready) { monitor.suspended = { record: ready, operation: await pauseOwnedReceiver(owner, { parent: target.meta.parent_process, sameProcess: s.sameProcess, processDescendsFrom: s.processDescendsFrom, paused }) }; return }
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      })().catch(error => { monitor.error = error })
      state(s).recovery = { fixture, target, monitor, owner }
      if (!owner || !s.sameProcess(owner)) fail('ACCEPTANCE_RECEIVER_NOT_LIVE', '専用watcherが存命ではありません')
      return s.result(s, 'own_receiver_suspension_armed', 'os_process', { owner, observation: 'ready保存の実境界を観測するmonitorの準備', monitor_started_at: new Date().toISOString() })
    }
    const operation = await pauseOwnedReceiver(owner, { parent: target.meta.parent_process, sameProcess: s.sameProcess, processDescendsFrom: s.processDescendsFrom, paused })
    state(s).recovery = { fixture, target, owner, operation }
    return s.result(s, 'own_receiver_suspended', 'os_process', operation)
  }
  actions.receiver_restart = async (_, s) => {
    const recovery = state(s).recovery, post = recordPending(s).at(-1)?.posted
    if (!post) fail('ACCEPTANCE_READY_SOURCE_MISSING', s.scenario)
    if (recovery.monitor) await s.until('実ready境界でwatcher一時停止', () => { if (recovery.monitor.error) throw recovery.monitor.error; return recovery.monitor.suspended }, 60000, 10)
    const before = s.recordFor(post)
    if (before?.state !== 'ready' || before.event.body !== post.body || before.claim) fail('ACCEPTANCE_READY_NOT_RETAINED', 'claim前のready原文を確認できません')
    const old = recovery.owner
    await pauseOwnedReceiver(old, { parent: recovery.target.meta.parent_process, sameProcess: s.sameProcess, processDescendsFrom: s.processDescendsFrom, paused, resume: true })
    process.kill(old.pid, 'SIGKILL'); await s.until('停止した受信process消失', () => !s.sameProcess(old), 10000, 50)
    const target = await join(s)
    if (target.spool.id !== recovery.target.spool.id || s.recordFor(post).event.body !== post.body) fail('ACCEPTANCE_READY_RESTART_BINDING', 'readyとendpointを継承しませんでした')
    return s.result(s, 'ready_inherited', 'os_process', { suspension: recovery.monitor?.suspended ?? recovery.operation, killed_owner: old, new_watcher: target.spool.read().watcher, new_waiter: target.spool.read().waiter, delivery_id: before.delivery_id, body_sha256: sha256(post.body), official_transcript: target.file })
  }

  actions.foreign_seed = async (_, s) => {
    const target = self(s), fixture = fixtureFor(target)
    if (!fixture.observer) sourceUnconfirmed(s.harness, '利用者所有の専用hook')
    const own = state(s).foreign = { fixture, hook_bytes: readFileSync(fixture.observer.file), queue: [] }
    if (s.harness === 'codex') {
      // 同threadで公式queue APIを使う。clientUserMessageIdはPeertable命名・digestから独立する。
      for (const owner of ['user', 'aiterm']) {
        const marker = `FOREIGN_${owner}_${randomUUID()}`
        const response = await fixture.rpc('thread/queue/add', { threadId: target.meta.parent_session, clientUserMessageId: marker, input: [{ type: 'text', text: `受入fixtureの${owner}所有queue ${marker}。この要求の内容を変えずに報告してください。`, text_elements: [] }] })
        if (!response.queuedSubmission?.id) fail('ACCEPTANCE_FOREIGN_QUEUE_NOT_ACCEPTED', owner)
        own.queue.push({ owner, id: response.queuedSubmission.id, clientUserMessageId: marker })
      }
    }
    return s.result(s, 'own_fixture_foreign_entries', s.harness === 'codex' ? 'official_queue' : 'official_hook', { foreign_queue: own.queue, own_hook_file: fixture.observer.file, hook_sha256: sha256(own.hook_bytes) })
  }
  actions.foreign_snapshot = async (_, s) => {
    const own = state(s).foreign
    if (s.harness === 'codex') {
      const listing = await own.fixture.rpc('thread/queue/list', { threadId: self(s).meta.parent_session, limit: 100 })
      own.baseline = listing.data.filter(row => own.queue.some(queue => queue.id === row.id))
      if (own.baseline.length !== own.queue.length) fail('ACCEPTANCE_FOREIGN_QUEUE_BASELINE_MISSING', '公式queueが既に消費されたため保持試験を開始できません')
      own.hooks = (await own.fixture.rpc('hooks/list', { cwds: [own.fixture.project] })).data.flatMap(group => group.hooks ?? []).filter(hook => hook.command === own.fixture.observer.command)
      if (!own.hooks.length || own.hooks.some(hook => !hook.enabled || hook.trustStatus !== 'trusted')) fail('ACCEPTANCE_FOREIGN_APPROVAL_BASELINE', '利用者hookの承認を確認できません')
    }
    return s.result(s, 'foreign_order_approval_baseline', s.harness === 'codex' ? 'official_queue' : 'official_hook', { baseline: own.baseline ?? null, hooks: own.hooks ?? null, hook_sha256: sha256(own.hook_bytes) })
  }
  actions.foreign_observe = async (_, s) => {
    const own = state(s).foreign; confirmOne(s)
    if (!readFileSync(own.fixture.observer.file).equals(own.hook_bytes)) fail('ACCEPTANCE_FOREIGN_HOOK_CHANGED', '利用者hook bytesを変更しました')
    own.fixture.configuration.assertHooksUnchanged()
    if (s.harness === 'codex') {
      const after = (await own.fixture.rpc('thread/queue/list', { threadId: self(s).meta.parent_session, limit: 100 })).data.filter(row => own.queue.some(queue => queue.id === row.id))
      const hooks = (await own.fixture.rpc('hooks/list', { cwds: [own.fixture.project] })).data.flatMap(group => group.hooks ?? []).filter(hook => hook.command === own.fixture.observer.command)
      if (!isDeepStrictEqual(after, own.baseline) || !isDeepStrictEqual(hooks, own.hooks)) fail('ACCEPTANCE_FOREIGN_QUEUE_OR_APPROVAL_CHANGED', '同threadの他所有queue・順序・承認が変わりました')
    }
    if (!observerRows(own.fixture).some(row => nativeSession(row.event) === self(s).meta.parent_session)) fail('ACCEPTANCE_FOREIGN_HOOK_NOT_EXECUTED', '利用者hookが実親で発火していません')
    return s.result(s, 'foreign_entries_unchanged', 'official_hook', { event_artifact: own.fixture.observer.observations, queue_baseline: own.baseline ?? null, hook_sha256: sha256(own.hook_bytes) })
  }

  // native taskの操作名・実task readerは各harnessの公式実測controllerだけを使用する。
  // controllerは任意の合否callbackを持たず、request/responseと公式task出力を返す。
  for (const [action, outcome] of [['background_cancel', 'cancel'], ['background_timeout', 'timeout'], ['background_exit', 'exit']]) {
    actions[action] = async (_, s) => {
      const target = self(s), fixture = fixtureFor(target), task = target.spool.read().waiter?.native_task
      if (!task || !fixture.adapter.taskController) sourceUnconfirmed(s.harness, `受信task ${outcome}`, { task_id: task?.id ?? null, native_task: task ?? null })
      if (!s.sameProcess(task.process_identity) || !s.sameProcess(target.spool.read().waiter.owner) || !s.processDescendsFrom(target.spool.read().waiter.owner, task.process_identity)) fail('ACCEPTANCE_NATIVE_TASK_OWNER', '製品receiptの実task所有を確認できません')
      const controller = fixture.adapter.taskController
      const before = await controller.read(task.id, { session: target.meta.parent_session })
      const response = await controller.request(outcome, { id: task.id, session: target.meta.parent_session })
      const after = await s.until('公式native task終了出力', async () => { const value = await controller.read(task.id, { session: target.meta.parent_session }); return value.finished === true ? value : null }, outcome === 'timeout' ? controller.timeoutWindowMs : 30000)
      if (after.id !== task.id || after.session !== target.meta.parent_session || after.outcome !== outcome || after.delivered === true) fail('ACCEPTANCE_BACKGROUND_END_ROUNDED', 'cancel/timeout/exitを本文配送へ丸めました')
      state(s).background ??= []; state(s).background.push({ task, before, response, after })
      if (outcome !== 'exit') await join(s)
      return s.result(s, `native_task_${outcome}_observed`, 'native_task', { native_task: task, request_response: response, before, after, task_artifact: after.artifact })
    }
  }
  actions.background_observe = async (_, s) => {
    const observations = state(s).background
    if (!observations || observations.length !== 3 || observations.some(item => item.after.delivered === true || JSON.stringify(item.after.output).includes('[Peertable'))) fail('ACCEPTANCE_TASK_END_BODY_CONFUSED', '3種類の終了観測が揃わないか本文へ混入しました')
    return s.result(s, 'task_end_not_delivered', 'native_task', { native_ends: observations })
  }
  actions.receiver_rearm = async (_, s) => {
    const before = self(s).spool.read(), target = await join(s), after = target.spool.read()
    if (target.spool.id !== self(s).spool.id || after.cursor < before.cursor || after.state !== 'verified' || after.runtime !== 'armed') fail('ACCEPTANCE_REARM_IDENTITY_OR_CURSOR', '同endpoint/cursorで再武装していません')
    if (['cursor', 'grok'].includes(s.harness) && (!after.waiter?.native_task || !s.sameProcess(after.waiter.owner))) fail('ACCEPTANCE_REARM_NATIVE_TASK_MISSING', '完成済みnative taskの再登録がありません')
    return s.result(s, s.scenario === 'lease' ? 'same_endpoint_cursor_rearmed' : 'native_receiving_rearmed', 'harness_transcript', { endpoint_id: target.spool.id, before_cursor: before.cursor, after_cursor: after.cursor, native_waiter: after.waiter })
  }

  actions.lease_expiry_arm = async (_, s) => {
    const target = self(s), fixture = fixtureFor(target), before = target.spool.read()
    if (s.harness === 'codex') {
      const artifact = s.artifactFor(s, 'queue-connections'), monitor = monitorQueueConnections({ watcher: before.watcher, executable: before.caller.owner.executable, processIdentity: s.processIdentity, sameProcess: s.sameProcess, artifact })
      state(s).lease = { before, fixture, monitor, artifact, armed_at: new Date().toISOString() }
      return s.result(s, 'own_finite_lease', 'os_process', { mechanism: '公式queue接続更新', watcher: before.watcher, process_artifact: artifact, product_connection_source: join(s.pkg, 'skill/scripts/parent-receivers/codex.mjs') })
    }
    if (!before.waiter?.owner || !s.sameProcess(before.waiter.owner)) fail('ACCEPTANCE_LEASE_OWNER_MISSING', '製品受信processのlease開始を確認できません')
    const controller = fixture.adapter.taskController
    state(s).lease = { before, fixture, armed_at: new Date().toISOString(), controller }
    // 製品の有限leaseを短縮・時計改変しない。正式runは実際の期限まで待つ。
    return s.result(s, 'own_finite_lease', s.harness === 'claude' ? 'official_hook' : 'native_task', { endpoint_id: target.spool.id, owner: before.waiter.owner, native_task: before.waiter.native_task ?? null, lease_source: join(s.pkg, `skill/scripts/parent-receivers/${s.harness === 'claude' ? 'claude' : 'background'}.mjs`) })
  }
  actions.lease_expiry_observe = async (_, s) => {
    const lease = state(s).lease, target = self(s)
    if (s.harness === 'codex') {
      const first = confirmOne(s)
      const closed = await s.until('queue受付後の公式接続終了', () => {
        if (lease.monitor.error) throw lease.monitor.error
        const at = Date.parse(first.receipt.accepted_at)
        return lease.monitor.connections.find(connection => Date.parse(connection.first_seen_at) <= at && connection.closed_at && Date.parse(connection.closed_at) >= at)
      }, 30000, 100)
      if (target.spool.read().endpoint_id !== lease.before.endpoint_id || target.spool.read().cursor < lease.before.cursor) fail('ACCEPTANCE_QUEUE_LEASE_IDENTITY', '接続終了がendpoint/cursorを失いました')
      return s.result(s, 'finite_lease_control_not_body', 'official_queue', { mechanism: '公式queue接続更新', connection: closed, queued_submission_id: first.receipt.queued_submission_id, accepted_at: first.receipt.accepted_at, queue_snapshot: await lease.fixture.rpc('thread/queue/list', { threadId: target.meta.parent_session, limit: 100 }), process_artifact: lease.artifact, control_notification_required: false })
    }
    // 期限前配送で最初のslotが終了し、親が作る次slotの実expiryを観測する。
    const waiter = await s.until('期限前配送後の次受信slot', () => { const current = target.spool.read().waiter; return current && current.owner.pid !== lease.before.waiter.owner.pid && s.sameProcess(current.owner) ? current : null }, 60000)
    const file = s.artifactFor(s, 'lease-control-output'), transcriptBefore = target.observe().rows
    let output
    if (s.harness === 'claude') {
      output = await s.until('通常asyncRewakeの有限lease終了', () => { const raw = readFileSync(target.file, 'utf8'), added = raw.split('\n').slice(transcriptBefore).join('\n'); return added.includes('PARENT_RECEIVER_EXPIRED') && added.includes(target.spool.id) && !s.sameProcess(waiter.owner) ? added : null }, 86460000, 5000)
      writeFileSync(file, output)
    } else {
      if (!lease.controller || !waiter.native_task?.id) sourceUnconfirmed(s.harness, '有限lease完了task reader')
      output = await s.until('通常native taskの有限lease終了', async () => { const value = await lease.controller.read(waiter.native_task.id, { session: target.meta.parent_session }); return value.finished === true ? value : null }, 86520000, 5000)
      if (output.outcome !== 'timeout' || !JSON.stringify(output.output).includes('PARENT_RECEIVER_EXPIRED')) fail('ACCEPTANCE_LEASE_CONTROL_MISSING', '公式期限通知を取得できません')
      writeFileSync(file, JSON.stringify(output))
    }
    if (target.observe().deliveries.some(delivery => delivery.body?.includes('peertable.parent-control.v1') || delivery.body?.includes('PARENT_RECEIVER_EXPIRED'))) fail('ACCEPTANCE_LEASE_CONTROL_AS_BODY', '制御通知がroom本文へ混入しました')
    return s.result(s, 'finite_lease_control_not_body', s.harness === 'claude' ? 'harness_transcript' : 'native_task', { expired_owner: waiter.owner, output_artifact: file, endpoint_id: target.spool.id, cursor: target.spool.read().cursor })
  }

  // この3障害は同じglobal所有hookの実効状態を変える必要がある。共有状態の無断変更は禁止。
  for (const [action, fault] of [['hook_disable', 'disabled'], ['hook_untrust', 'untrusted'], ['hook_remove_file', 'file_missing']]) {
    actions[action] = async (_, s) => {
      const fixture = fixtureFor(self(s)), config = fixture.configuration
      if (s.harness === 'codex' && fault !== 'file_missing') {
        const proof = await fixture.setCodexOwnedHookFault(fault)
        state(s).hookFault = { fixture, fault, proof }
        return s.result(s, fault === 'disabled' ? 'own_hook_disabled' : 'own_hook_untrusted', 'official_hook', proof)
      }
      const observed = s.harness === 'codex' ? await fixture.rpc('hooks/list', { cwds: [fixture.project] }) : config.beforeHooks
      const artifact = s.artifactFor(s, `global-${fault}-boundary`)
      writeFileSync(artifact, JSON.stringify({ harness: s.harness, fault, sourcePath: config.hooks, observed, reason: '共有global所有hookと通常配布物を保持したまま、専用sessionだけに適用する公式経路の確認が必要' }, null, 2))
      fail('ACCEPTANCE_SHARED_HOOK_FAULT_SCOPE_UNCONFIRMED', `${s.harness}/${fault}: 他親へ影響しない同global所有hook障害の公式経路が未確認です`, { sourcePath: config.hooks, artifact })
    }
  }
  actions.join_expect_failure = async (_, s) => {
    const fault = state(s).hookFault
    if (!fault) sourceUnconfirmed(s.harness, '専用sessionに限定したhook障害join')
    const target = self(s), before = target.observe().rows
    await fault.fixture.submit(`Peertable parent_joinをproject=${fault.fixture.project} name=${fault.fixture.name}で1回呼び、返されたerror codeをそのまま報告してください。再試行や設定変更はしないでください。`)
    const expected = 'PARENT_CODEX_HOOK_UNTRUSTED'
    const observed = await s.until('障害joinの公式tool返答', () => {
      const seen = target.observe(), uses = seen.toolUses.filter(use => use.order >= before && /parent_join$/u.test(use.name ?? ''))
      for (const use of uses) {
        const output = seen.toolUses.find(row => row.name === 'output' && row.id === use.id && row.order > use.order && productToolError(row.output, expected))
        if (output) return { use, output }
      }
      return null
    }, 120000, 100)
    const failed = target.spool.read()
    const error = productToolError(observed.output.output, expected)
    if (!error) fail('ACCEPTANCE_HOOK_JOIN_NOT_TYPED_FAILED', '公式MCP parent-errorのschema/state/error_codeが一致しません')
    return s.result(s, fault.fault === 'disabled' ? 'disabled_hook_typed_failure' : 'untrusted_hook_typed_failure', 'harness_transcript', { error_code: error.error_code, existing_endpoint_state: failed.state, failure_stage: 'joinEndpointより前の公式receiver検証', tool_use_id: observed.use.id, official_tool_output: observed.output.output, parent_session: target.meta.parent_session, turn_id: observed.output.turn_id, sourcePath: fault.proof.global_sourcePath, local_config: fault.proof.local_config })
  }
  actions.hook_restore = async (_, s) => { fixtureFor(self(s)).configuration.assertHooksUnchanged(); return s.result(s, 'normal_launch_intact', 'official_hook', { configuration_unchanged: true }) }

  // 期限は製品の実bind/probe境界で待つ。保存stateへ時刻を代入するfixtureは受入へ使わない。
  for (const action of ['binding_timeout_arm', 'binding_timeout_observe', 'probe_timeout_arm', 'probe_timeout_observe', 'deadline_restore']) {
    actions[action] = async (_, s) => { sourceUnconfirmed(s.harness, '公式MCP相関を保持した専用binding/probe遮断', { source: join(s.pkg, 'skill/scripts/parent-caller.mjs'), probe_source: join(s.pkg, 'skill/scripts/parent-watch.mjs'), parent_session: self(s).meta.parent_session }) }
  }

  const lifecycleOperation = async (s, mode) => {
    if (!lifecycle?.currentTarball || !lifecycle?.nextTarball || !lifecycle?.prefix || !lifecycle?.exclusiveEndpoints) sourceUnconfirmed(s.harness, '共通導入物の同版/新版更新の専用所有範囲')
    const { endpointsFor } = await import(pathToFileURL(join(s.pkg, 'skill/scripts/parent-caller.mjs')).href)
    const others = endpointsFor().filter(endpoint => endpoint.read().runtime !== 'stopped' && !lifecycle.exclusiveEndpoints.includes(endpoint.id))
    if (others.length) fail('ACCEPTANCE_SHARED_INSTALL_BUSY', '更新が試験外の親へ影響します', { endpoints: others.map(endpoint => endpoint.id) })
    const target = self(s), fixture = fixtureFor(target)
    if (!fixture.adapter.reconnectMcp) sourceUnconfirmed(s.harness, '通常CLIの公式MCP再接続command', { parent_session: target.meta.parent_session })
    const before = target.spool.read(), tarball = mode === 'same' ? lifecycle.currentTarball : lifecycle.nextTarball
    const argv = ['install', '--prefix', lifecycle.prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball]
    const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', argv, { encoding: 'utf8', shell: process.platform === 'win32' })
    const installed = JSON.parse(readFileSync(join(s.pkg, 'package.json'), 'utf8'))
    if (mode === 'same' && installed.version !== s.meta.package_version || mode === 'new' && installed.version === s.meta.package_version) fail('ACCEPTANCE_LIFECYCLE_VERSION', '要求した同版/新版の導入が不一致です')
    const after = target.spool.read()
    if (!s.sameProcess(target.meta.parent_process) || after.cursor !== before.cursor || !isDeepStrictEqual(after.records, before.records)) fail('ACCEPTANCE_LIFECYCLE_HISTORY_LOST', '更新が親processまたは配送履歴を変更しました')
    await fixtureFor(target).adapter.reconnectMcp(fixtureFor(target))
    await join(s)
    return s.result(s, mode === 'same' ? 'same_version_single_registration' : 'new_version_history_binding_preserved', 'installed_package', { before_version: s.meta.package_version, after_version: installed.version, tarball_sha256: sha256(readFileSync(tarball)), package_output: output, endpoint_id: target.spool.id, cursor: after.cursor })
  }
  actions.same_version_update = (_, s) => lifecycleOperation(s, 'same')
  actions.new_version_update = (_, s) => lifecycleOperation(s, 'new')
  actions.teardown = async (_, s) => {
    const target = self(s), fixture = fixtureFor(target), original = (await target.api('messages')).messages
    if (!lifecycle?.exclusiveEndpoints) sourceUnconfirmed(s.harness, '公式teardownのglobal所有範囲')
    // 製品teardownが共通接続を解除する可能性を事前に排除できない時は動かさない。
    const { endpointsFor } = await import(pathToFileURL(join(s.pkg, 'skill/scripts/parent-caller.mjs')).href)
    if (!endpointsFor().some(endpoint => endpoint.project !== fixture.project && endpoint.read().harness === s.harness && endpoint.read().runtime !== 'stopped')) fail('ACCEPTANCE_TEARDOWN_SHARED_CONNECTION_SCOPE', '通常global接続を保持する別fixtureが必要です')
    const bin = join(lifecycle.prefix, 'node_modules/.bin', process.platform === 'win32' ? 'peertable.cmd' : 'peertable')
    const output = execFileSync(bin, ['teardown', fixture.project], { cwd: fixture.project, env: { ...process.env, PEERTABLE_TOKEN_SOURCE_FILE: lifecycle.tokenFile }, encoding: 'utf8', shell: process.platform === 'win32' })
    const messages = (await target.api('messages')).messages
    if (!s.sameProcess(target.meta.parent_process) || original.some(before => !messages.some(after => isDeepStrictEqual(before, after)))) fail('ACCEPTANCE_TEARDOWN_PARENT_OR_HISTORY', 'teardownで親またはroom履歴を失いました')
    fixture.configuration.assertHooksUnchanged()
    state(s).teardown = { fixture, old: target, original, output }
    return s.result(s, 'receiver_stopped_parent_alive_history_kept', 'harness_transcript', { parent_process: target.meta.parent_process, old_endpoint: target.spool.id, archived_files: readdirSync(join(fixture.project, 'docs/archive')), command_output: output })
  }
  actions.lifecycle_rejoin = async (_, s) => {
    const previous = state(s).teardown
    mkdirSync(join(previous.fixture.project, '.team'), { recursive: true })
    writeFileSync(join(previous.fixture.project, '.team/setup-state.json'), JSON.stringify({ room: previous.old.meta.room, server_url: lifecycle.serverUrl, mode: 'adhoc' }))
    const target = await previous.fixture.join()
    if (target.spool.id === previous.old.spool.id || target.meta.parent_session !== previous.old.meta.parent_session) fail('ACCEPTANCE_LIFECYCLE_REJOIN_BINDING', '新bindingと同会話を確認できません')
    s.context.registerEndpoint('self', target)
    return s.result(s, 'new_binding_after_teardown', 'harness_transcript', { endpoint_id: target.spool.id, old_endpoint: previous.old.spool.id })
  }

  return { actions, async finalize(s) {
    const errors = []
    try {
    const current = saved.get(s.runId)
    if (current?.work) { writeFileSync(current.work.release, '{}'); if (current.work.owner) await waitOwnedFixtureExit({ readEndpoints: () => [], knownOwners: [current.work.owner], indexExists: () => false, sameProcess: s.sameProcess, timeout: 30000 }) }
    if (current?.final) { writeFileSync(current.final.release, '{}'); if (current.final.monitor) { current.final.monitor.canceled = true; await current.final.monitor.promise } }
    if (current?.recovery?.monitor) { current.recovery.monitor.canceled = true; await current.recovery.monitor.promise }
    for (const owner of paused.values()) if (s.sameProcess(owner)) await pauseOwnedReceiver(owner, { parent: self(s).meta.parent_process, sameProcess: s.sameProcess, processDescendsFrom: s.processDescendsFrom, paused, resume: true })
    // queue撤去はこのfixtureが公式APIで作成したIDだけ。利用者/Aiterm実設定を削除しない。
    for (const entry of current?.foreign?.queue ?? []) await current.foreign.fixture.rpc('thread/queue/delete', { threadId: self(s).meta.parent_session, queuedSubmissionId: entry.id })
    if (current?.lease?.monitor) {
      const monitor = current.lease.monitor
      for (const connection of monitor.connections) if (!connection.closed_at && !s.sameProcess(connection.owner)) connection.closed_at = new Date().toISOString()
      await monitor.close()
      if (s.checks.length >= 2) {
        const proof = queueConnectionProof(monitor.connections, s.checks)
        writeFileSync(current.lease.artifact, JSON.stringify({ connections: monitor.connections, native_acceptance_proof: proof }, null, 2))
      }
    }
    } catch (error) { errors.push(error) }
    try { await factory.close() } catch (error) { errors.push(error) }
    if (errors.length) throw Object.assign(new AggregateError(errors, '追加scenarioの所有資産を後片付けできません'), { code: 'ACCEPTANCE_NATIVE_CLEANUP_FAILED' })
  } }
}

// rootの既存runnerへ接続する入口。scenarioごとに新CIDと専用artifactを作り、証拠を使い回さない。
export async function createNativeScenarioContext(name, options) {
  const surfaceAdapters = { ...(['cursor', 'grok'].includes(options.sourceMeta.harness) ? await createBackgroundSurfaceAdapters(options) : {}), ...options.surfaceAdapters }
  const factory = await createNativeFixtureFactory({ ...options, surfaceAdapters })
  let primary
  try {
    primary = await factory.open({ harness: options.sourceMeta.harness, name: `scenario-${name}-${randomUUID().slice(0, 8)}`, prepare: async fixture => {
      if (['final_race', 'session_change', 'foreign_ownership'].includes(name)) await fixture.addObserver({ events: name === 'session_change' ? ['SessionStart'] : ['Stop', 'PostToolUse'] })
      if (['claim_race', 'slot_race'].includes(name)) await fixture.addProductCompetitors({ count: 2 })
      if (name === 'compatibility_hooks') await fixture.addProductCompetitors({ count: 1, compatibilityHarness: options.sourceMeta.harness === 'claude' ? 'codex' : 'claude' })
    } })
    const native = createNativeActions({ factory, primary, lifecycle: options.lifecycle })
    const context = await createScenarioContext({ ...options, ...primary.target, projectDir: primary.project, privateDir: primary.directory, nativeActions: native.actions })
    context.registerEndpoint('self', primary.target)
    const ordinaryFinalize = context.finalize
    // native finalizeには同じ実境界の所有helpersを渡す。判定をcallbackから受け取らない。
    const platform = await import(pathToFileURL(join(options.pkg, 'skill/scripts/parent-platform.mjs')).href)
    context.finalize = async scope => { const errors = []; try { await ordinaryFinalize(scope) } catch (error) { errors.push(error) }; try { await native.finalize({ ...scope, context, ...platform }) } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors, 'scenario所有process/設定の後片付けに失敗しました') }
    context.caseMeta = primary.target.meta
    return context
  } catch (error) { try { await factory.close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'fixture準備と後片付けに失敗しました') }; throw error }
}
