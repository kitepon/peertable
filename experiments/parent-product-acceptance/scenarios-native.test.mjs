// 追加adapterの誤相関をfocusedで確認する。fixtureの合格をproduct_liveへ流用しない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { competitorProof, queueConnectionProof, monitorQueueConnections, createNativeActions, productToolError, assertOwnedReceiver, assertOwnedResume, pauseOwnedReceiver, nativeLeaseRegistration, bindingContextProof, bindingToolError } from './scenarios-native.mjs'
import { processIdentity, sameProcess, processDescendsFrom } from '../../skill/scripts/parent-platform.mjs'
import { scenarioPlan } from './scenarios.mjs'
import { digest } from '../../skill/scripts/parent-delivery.mjs'

const event = { session_id: 'own', turn_id: 'turn', hook_event_name: 'PostToolUse', tool_use_id: 'tool' }
const pair = (pid, value = event, stdout = '{}', code = 0) => [{ phase: 'started', pid, event: value }, { phase: 'completed', pid, event: value, stdout, code }]

test('競合証拠は同eventの異なる実processに限定し、event合算と二重完了を拒否する', () => {
  const options = { session: 'own', delivery: { turn_id: 'turn' } }
  assert.equal(competitorProof([...pair(1), ...pair(2)], options).starts.length, 2)
  assert.throws(() => competitorProof([...pair(1), ...pair(2, { ...event, tool_use_id: '別tool' })], options), { code: 'ACCEPTANCE_HOOK_COMPETITION_NOT_OBSERVED' })
  assert.throws(() => competitorProof([...pair(1), ...pair(1)], options), { code: 'ACCEPTANCE_HOOK_COMPETITION_NOT_OBSERVED' })
  assert.throws(() => competitorProof([...pair(1, event, '本文'), ...pair(2, event, '本文')], options), { code: 'ACCEPTANCE_CLAIM_OUTPUT_DUPLICATED' })
  assert.throws(() => competitorProof(pair(1, event, '本文'), { ...options, minimum: 1, compatibility: true }), { code: 'ACCEPTANCE_COMPATIBILITY_DUPLICATE' })
  assert.throws(() => competitorProof([...pair(1, { ...event, session_id: '他親' }), ...pair(2, { ...event, session_id: '他親' })], options), { code: 'ACCEPTANCE_HOOK_COMPETITION_NOT_OBSERVED' })
})

test('Codexの停止準備は停止済みと区別し、他harnessの実停止契約を保持する', () => {
  assert.equal(scenarioPlan('process_recovery', { harness: 'codex' })[0].expectation, 'own_receiver_suspension_armed')
  assert.equal(scenarioPlan('process_recovery', { harness: 'claude' })[0].expectation, 'own_receiver_suspended')
})

test('公式queue受付は接続存命時間と一意に照合し、新しい接続を要求する', () => {
  const make = (pid, first, closed) => ({ owner: { pid, started: String(pid) }, first_seen_at: new Date(first).toISOString(), closed_at: new Date(closed).toISOString() })
  const check = (seq, at) => ({ original: { seq }, receipt: { queued_submission_id: `queue-${seq}`, accepted_at: new Date(at).toISOString() } })
  assert.equal(queueConnectionProof([make(1, 100, 200), make(2, 250, 350)], [check(1, 150), check(2, 300)]).length, 2)
  assert.throws(() => queueConnectionProof([make(1, 100, 350)], [check(1, 150), check(2, 300)]), { code: 'ACCEPTANCE_QUEUE_CONNECTION_NOT_UPDATED' })
  assert.throws(() => queueConnectionProof([make(1, 100, 250), make(2, 120, 240)], [check(1, 150), check(2, 200)]), { code: 'ACCEPTANCE_QUEUE_CONNECTION_UNBOUND' })
  assert.throws(() => queueConnectionProof([make(1, 100, 250)], [{ original: { seq: 1 }, receipt: {} }]), { code: 'ACCEPTANCE_QUEUE_ACCEPTANCE_MISSING' })
})

test('接続monitorは専用watcherの実child起動と消失を観測する', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-queue-process-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 公式app-serverの動作は代替しない。実childのtree/identityを読むobserver部分だけの試験。
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),700)','app-server','--listen','stdio://'],{stdio:'ignore'});child.on('spawn',()=>console.log(JSON.stringify({pid:child.pid})));child.on('exit',()=>console.log(JSON.stringify({closed:true})));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`
  const watcher = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => { if (watcher.exitCode === null) watcher.kill('SIGKILL') })
  const lineReader = createInterface({ input: watcher.stdout }); t.after(() => lineReader.close())
  const lines = []; lineReader.on('line', line => lines.push(JSON.parse(line)))
  const identity = processIdentity(watcher.pid)
  const monitor = monitorQueueConnections({ watcher: identity, executable: process.execPath, processIdentity, sameProcess, artifact: join(dir, 'connections.json'), interval: 30 })
  t.after(async () => { monitor.canceled = true; await monitor.promise })
  const end = Date.now() + 4000
  while (!monitor.connections[0]?.closed_at) { if (monitor.error) throw monitor.error; assert.ok(Date.now() < end, '実childの接続終了を観測できません'); await new Promise(resolve => setTimeout(resolve, 30)) }
  await monitor.close()
  assert.equal(monitor.connections.length, 1); assert.equal(monitor.connections[0].owner.pid, lines[0].pid)
  assert.equal(monitor.connections[0].watcher.pid, watcher.pid)
  watcher.stdin.end(); await new Promise(resolve => watcher.once('exit', resolve))
})

test('final armがobserver待ちで失敗してもreleaseとfactory cleanupを実行する', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-final-cleanup-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  let closed = false
  const fixture = { observer: { controls: join(dir, 'controls'), observations: join(dir, 'events') }, submit: async () => {} }
  const primary = { target: { fixture, meta: { parent_session: 'own' } } }
  const native = createNativeActions({ factory: { close: async () => { closed = true } }, primary: fixture })
  const scope = { runId: 'run', context: { endpoint: () => primary.target }, artifactFor: () => join(dir, 'release'), until: async () => { throw Object.assign(new Error('実event待ち失敗'), { code: 'TEST_EVENT_TIMEOUT' }) }, sameProcess: () => false }
  await assert.rejects(native.actions.final_arm({}, scope), { code: 'TEST_EVENT_TIMEOUT' })
  await native.finalize(scope); assert.equal(closed, true)
})


test('join失敗は公式parent-errorだけから判定し、既存endpointや自由文から推測しない', () => {
  const error = { schema: 'peertable.parent-error.v1', state: 'failed', error_code: 'PARENT_CODEX_HOOK_UNTRUSTED' }
  assert.deepEqual(productToolError(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(error) }], structuredContent: error, isError: true }), error.error_code), error)
  assert.equal(productToolError(`説明中の ${error.error_code}`, error.error_code), null)
  assert.equal(productToolError({ ...error, state: 'verified' }, error.error_code), null)
  assert.equal(productToolError({ ...error, error_code: '別code' }, error.error_code), null)
})


test('独立watcherはown spoolとcaller本人で確認し、他endpoint共有とidentity差を拒否する', () => {
  const parent = { pid: 100, started: '親開始' }, owner = { pid: 200, started: 'watcher開始' }
  const fixture = { project: '/専用project', harness: 'codex' }
  const state = { endpoint_id: 'own', harness: 'codex', runtime: 'armed', caller: { harness: 'codex', conversation: 'own会話', owner: parent }, watcher: owner }
  const target = { fixture, meta: { parent_process: parent, parent_session: 'own会話' }, spool: { project: fixture.project, id: 'own', read: () => state } }
  const options = { target, fixture, sameProcess: () => true, processDescendsFrom: () => false, endpoints: [] }
  assert.equal(assertOwnedReceiver(owner, options).receiver_role, 'watcher')
  assert.throws(() => assertOwnedReceiver({ ...owner, started: '再利用PID' }, options), { code: 'ACCEPTANCE_PROCESS_FAULT_OWNER' })
  assert.throws(() => assertOwnedReceiver(owner, { ...options, endpoints: [{ id: '他endpoint', read: () => ({ runtime: 'armed', watcher: owner }) }] }), { code: 'ACCEPTANCE_PROCESS_FAULT_SHARED' })
  state.caller.conversation = '別会話'
  assert.throws(() => assertOwnedReceiver(owner, options), { code: 'ACCEPTANCE_PROCESS_FAULT_CALLER' })
  state.caller.conversation = 'own会話'; state.watcher = null; state.waiter = { owner }
  assert.throws(() => assertOwnedReceiver(owner, options), { code: 'ACCEPTANCE_PROCESS_FAULT_OWNER' })
})


test('停止時の証拠でown receiverを再開し、終了した親と再利用PIDを区別する', () => {
  const parent = { pid: 100, started: '親開始' }, owner = { pid: 200, started: 'watcher開始' }
  const fixture = { project: '/専用project', harness: 'codex' }
  const current = { endpoint_id: 'own', harness: 'codex', caller: { harness: 'codex', conversation: 'own会話', owner: parent }, watcher: owner }
  const target = { fixture, meta: { parent_process: parent, parent_session: 'own会話' }, spool: { project: fixture.project, id: 'own', read: () => current } }
  const proof = assertOwnedReceiver(owner, { target, fixture, sameProcess: () => true, processDescendsFrom: () => false, endpoints: [] })
  const held = { target, fixture, owner: structuredClone(owner), proof: structuredClone(proof) }
  const sameProcess = value => value.pid === owner.pid && value.started === owner.started
  current.watcher = null; current.runtime = 'stopped'
  assert.deepEqual(assertOwnedResume(owner, { target, fixture, held, sameProcess, endpoints: [] }), proof)
  assert.throws(() => assertOwnedResume({ ...owner, started: '再利用PID' }, { target, fixture, held, sameProcess, endpoints: [] }), { code: 'ACCEPTANCE_PROCESS_RESUME_OWNER' })
  assert.throws(() => assertOwnedResume(owner, { target: { ...target }, fixture, held, sameProcess, endpoints: [] }), { code: 'ACCEPTANCE_PROCESS_RESUME_OWNER' })
})


test('実processで独立receiverを停止し、親が先に終了しても再開して回収する', { skip: process.platform === 'win32' }, async t => {
  // 実CLI/製品配送の代用ではなく、own子processに対する停止・再開境界だけを再現する。
  const script = 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'
  const parentChild = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'inherit'] }), receiver = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'inherit'] })
  t.after(() => { if (parentChild.exitCode === null) parentChild.kill('SIGKILL'); if (receiver.exitCode === null) { receiver.kill('SIGCONT'); receiver.kill('SIGKILL') } })
  const parent = processIdentity(parentChild.pid), owner = processIdentity(receiver.pid)
  const fixture = { project: '/focused独立receiver', harness: 'codex', pkg: process.cwd() }, current = { endpoint_id: 'own', harness: 'codex', caller: { harness: 'codex', conversation: 'own会話', owner: parent }, watcher: owner }
  const target = { fixture, meta: { parent_process: parent, parent_session: 'own会話' }, spool: { project: fixture.project, id: 'own', read: () => current } }, paused = new Map()
  const options = { target, fixture, sameProcess, processDescendsFrom, paused }
  assert.equal((await pauseOwnedReceiver(owner, options)).operation, 'suspend')
  assert.match(execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'state='], { encoding: 'utf8' }), /T/u)
  const parentGone = new Promise(resolve => parentChild.once('exit', resolve)); parentChild.stdin.end(); await parentGone
  assert.equal(sameProcess(parent), false)
  assert.equal((await pauseOwnedReceiver(owner, { ...options, resume: true })).operation, 'resume'); assert.equal(paused.size, 0)
  const receiverGone = new Promise(resolve => receiver.once('exit', resolve)); receiver.stdin.end(); await receiverGone
  assert.equal(sameProcess(owner), false)
})


test('lease開始はverified後の未登録期間を待ち、公式tool/task登録と本人を照合する', () => {
  const owner = { pid: 200, started: 'own開始' }, input = { command: '完成済み', cwd: '/専用' }, native = { id: 'own-task', pid: owner.pid, process_identity: owner, input: { name: 'Shell', input } }
  const current = { state: 'verified', runtime: 'rearm_pending', waiter: null }, use = { id: 'use', turn_id: 'turn', name: 'Shell', session: 'own', input }, task = { id: 'own-task', tool_use_id: 'use', pid: owner.pid }
  const target = { spool: { read: () => current }, meta: { harness: 'cursor', parent_session: 'own' }, observe: () => ({ toolUses: [use], tasks: [task] }) }
  const options = { sameProcess: () => true, processDescendsFrom: () => true }
  assert.equal(nativeLeaseRegistration(target, options), null)
  current.runtime = 'armed'; current.waiter = { owner, native_task: native }
  assert.equal(nativeLeaseRegistration(target, options).registration.task_id, 'own-task')
  use.session = '他会話'; assert.equal(nativeLeaseRegistration(target, options), null)
  use.session = 'own'; task.pid = 999; assert.equal(nativeLeaseRegistration(target, options), null)
  current.state = 'failed'; current.error_code = '実製品error'
  assert.throws(() => nativeLeaseRegistration(target, options), { code: current.error_code })
})


test('束縛contextは実file原bytesと同会話/tool入力/PID開始identityで照合する', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-binding-context-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'context.json'), owner = processIdentity(process.pid), input = { name: '専用親', project: '/専用 project' }, event = { tool_use_id: 'official-use', tool_input: input }
  const value = { harness: 'claude', conversation: 'own-CID', use: event.tool_use_id, name: 'parent_join', input_digest: digest(input), owner, created_at: Date.now() }
  const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n'); writeFileSync(file, raw)
  const options = { file, harness: 'claude', parentSession: value.conversation, parentProcess: owner, event, digest, sameProcess }
  const proof = bindingContextProof(options)
  assert.deepEqual(proof.value, value); assert.match(proof.sha256, /^[0-9a-f]{64}$/u); assert.deepEqual(readFileSync(file), raw)
  for (const changed of [{ conversation: 'other-CID' }, { use: 'other-use' }, { input_digest: digest({ ...input, name: '別親' }) }, { owner: { ...owner, started: 'PID再利用' } }, { created_at: null }]) {
    writeFileSync(file, JSON.stringify({ ...value, ...changed })); assert.throws(() => bindingContextProof(options), { code: 'ACCEPTANCE_BIND_CONTEXT_OWNER' })
  }
  const grok = { ...value, harness: 'grok' }; writeFileSync(file, JSON.stringify(grok))
  assert.deepEqual(bindingContextProof({ ...options, harness: 'grok', event: { toolUseId: value.use, toolInput: { tool_input: input } } }).value, grok)
  assert.throws(() => bindingContextProof({ ...options, harness: 'grok', event: { toolUseId: value.use, toolInput: input } }))
  rmSync(file); assert.equal(bindingContextProof(options), null)
})

test('Grokの公式MCP包装だけから束縛期限errorを読み、説明文や別toolを拒否する', () => {
  const error = { schema: 'peertable.parent-error.v1', state: 'failed', error_code: 'PARENT_BIND_TIMEOUT' }
  const wrapped = { type: 'MCP', tool_name: 'parent_join', output: { OkayOutput: { structuredContent: error } } }
  assert.deepEqual(productToolError(wrapped, error.error_code), error)
  assert.equal(productToolError({ ...wrapped, tool_name: '無関係tool' }, error.error_code), null)
  assert.equal(productToolError({ ...wrapped, output: { OkayOutput: 'PARENT_BIND_TIMEOUTと説明する自由文' } }, error.error_code), null)
})

test('束縛armが実event待ちで失敗しても私物holdを解除してfactoryを閉じる', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-binding-cleanup-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const release = join(dir, 'release'), fixture = { project: '/専用project', name: '専用親', observer: { controls: join(dir, 'controls'), observations: join(dir, 'events') }, submit: async () => {} }
  const target = { fixture, meta: { parent_session: 'own' } }; let closed = false
  const native = createNativeActions({ factory: { close: async () => { closed = true } }, primary: fixture })
  const scope = { harness: 'claude', runId: 'binding-run', context: { endpoint: () => target }, artifactFor: () => release, until: async () => { throw Object.assign(new Error('実event待ち失敗'), { code: 'TEST_BIND_EVENT_TIMEOUT' }) }, sameProcess: () => false }
  await assert.rejects(native.actions.binding_timeout_arm({}, scope), { code: 'TEST_BIND_EVENT_TIMEOUT' })
  assert.equal(existsSync(release), false); await native.finalize(scope)
  assert.equal(readFileSync(release, 'utf8'), '{}'); assert.equal(closed, true)
})


test('束縛失敗はClaude実tool名と同ID user.tool_resultの原包装から読む', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-binding-result-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'transcript.jsonl'), error = { schema: 'peertable.parent-error.v1', state: 'failed', error_code: 'PARENT_BIND_TIMEOUT' }
  const tool = { type: 'tool_use', id: 'toolu_actual', name: 'mcp__peertable_parent__parent_join', input: { project: '/own', name: '親' } }, result = { type: 'tool_result', tool_use_id: tool.id, content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(error) }], isError: true }) }], is_error: true }
  const records = [{ type: 'assistant', sessionId: 'own', message: { content: [tool] } }, { type: 'user', sessionId: 'other', message: { content: [result] } }, { type: 'user', sessionId: 'own', message: { content: [{ ...result, tool_use_id: '他tool' }] } }, { type: 'user', sessionId: 'own', uuid: 'result-entry', message: { content: [result] } }]
  const write = rows => writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n' + '{"未確定tail":')
  const options = { harness: 'claude', file, session: 'own', useId: tool.id, expected: error.error_code }
  write(records); const proof = bindingToolError(options)
  assert.deepEqual(proof.output, result); assert.deepEqual(proof.error, error); assert.equal(proof.use.name, tool.name); assert.equal(proof.output_order, 3); assert.equal(proof.output_entry_uuid, 'result-entry')
  write(records.slice(0, 3)); assert.equal(bindingToolError(options), null)
  write([{ ...records[0], message: { content: [{ ...tool, name: 'mcp__other__parent_join' }] } }, records[3]]); assert.equal(bindingToolError(options), null)
  for (const harness of ['cursor', 'grok']) {
    const output = harness === 'grok' ? { type: 'MCP', tool_name: 'parent_join', output: { OkayOutput: JSON.stringify(error) } } : { content: [{ type: 'text', text: JSON.stringify(error) }] }
    const use = { id: tool.id, name: 'parent_join', session: 'own', output, order: 4 }
    assert.deepEqual(bindingToolError({ ...options, harness, seen: { toolUses: [use] } }).error, error)
    assert.equal(bindingToolError({ ...options, harness, seen: { toolUses: [{ ...use, session: 'other' }] } }), null)
  }
})
