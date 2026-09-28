// focused testはrunnerの判定と障害proxyを確認する。fixtureの結果をproduct_live証拠へ出さない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scenarios as inventory } from '../../scripts/parent-delivery-acceptance.mjs'
import { scenarioNames, scenarioPlan, runScenario, validateBoundary, validateNativeCheck } from './scenarios.mjs'
import { createScenarioProxy, nativeReadPages, assembleNativePages, noToolsReception, codexTurns, assertCodexBusy, nativeReceiveToolAllowed, nativeReceiveReaderAllowed, cursorIdleCompletion } from './scenarios-context.mjs'

const check = () => ({ run_id: 'run', scenario: 'package', status: 'passed', body_equal: true, count: 1, nonce: 'unique', harness: 'claude', original: { room: 'room', from: 'probe', to: 'bell', seq: 1, body: '日本語 & 字面&gt;' }, received: { room: 'room', from: 'probe', to: 'bell', seq: 1, body: '日本語 & 字面&gt;' }, delivery: { session: 'session', turn_id: 'turn', order: 2 }, reply: { session: 'session', turn_id: 'turn2', order: 3, text: 'unique' }, receipt: { result: 'delivered', receipt_revision: 1 } })
const checkScope = { runId: 'run', scenario: 'package', session: 'session' }

test('正本のaudience以外24scenarioに専用手順がある', () => {
  assert.equal(scenarioNames.length, 24)
  assert.deepEqual(scenarioNames, Object.keys(inventory).filter(name => name !== 'audience'))
  for (const name of scenarioNames) {
    const plan = scenarioPlan(name, { pageChars: 100 })
    assert.ok(plan.length > 1)
    assert.ok(plan.every(item => item.action && item.expectation))
  }
})
test('未知scenarioと導入物のpage上限不足をtyped failureにする', () => {
  assert.throws(() => scenarioPlan('fake'), { code: 'ACCEPTANCE_SCENARIO_UNKNOWN' })
  assert.throws(() => scenarioPlan('original'), { code: 'ACCEPTANCE_PAGE_LIMIT_MISSING' })
})
test('adapter未接続時は操作前に停止し、成績を作らない', async () => {
  let calls = 0
  await assert.rejects(runScenario('busy', { harness: 'codex', session: 'session', pageChars: 100, actions: { deliver: () => { calls++ } } }), { code: 'ACCEPTANCE_SCENARIO_ADAPTER_MISSING' })
  assert.equal(calls, 0)
})
test('原文と実会話・後続応答・receiptのすべてが必要', () => {
  assert.equal(validateNativeCheck(check(), checkScope).status, 'passed')
  for (const mutation of [item => { item.received.body = '変更' }, item => { item.delivery.session = '別会話' }, item => { item.reply = null }, item => { item.receipt = null }, item => { item.count = 2 }, item => { item.run_id = '別試験' }]) {
    const item = check(); mutation(item); assert.throws(() => validateNativeCheck(item, checkScope))
  }
})
test('Codex queue受付とXML一度復号以外の本文加工を拒否する', () => {
  const item = check(); item.harness = 'codex'
  assert.throws(() => validateNativeCheck(item, checkScope), { code: 'ACCEPTANCE_CODEX_QUEUE_RECEIPT_MISSING' })
  Object.assign(item.receipt, { queued_submission_id: 'queue', accepted_at: new Date().toISOString() })
  item.delivery.boundary = { encoding: 'whitespace_normalized' }
  assert.throws(() => validateNativeCheck(item, checkScope), { code: 'ACCEPTANCE_BODY_NORMALIZATION_FORBIDDEN' })
})
test('spool/fixtureだけの観測や別scenarioのartifactを実機に使わない', () => {
  const scope = { ...checkScope, expectation: 'receipt_only_recovered' }
  const row = { kind: 'receipt', run_id: 'run', scenario: 'package', parent_session: 'session', turn_id: 'turn', artifact: '/fixture.json', source: 'spool' }
  assert.throws(() => validateBoundary({ expectation: scope.expectation, verified: true, observations: [row] }, scope), { code: 'ACCEPTANCE_BOUNDARY_EVIDENCE_INVALID' })
  row.source = 'http_boundary'; row.scenario = 'audience'
  assert.throws(() => validateBoundary({ expectation: scope.expectation, verified: true, observations: [row] }, scope), { code: 'ACCEPTANCE_BOUNDARY_EVIDENCE_INVALID' })
})
test('最終pageまで順序どおり読み、本文の字面を保つ', () => {
  const pages = [
    { page: { delivery_id: 'id', digest: 'digest', offset: 0, total_characters: 7, complete: false, event: { body: '日本語' } } },
    { page: { delivery_id: 'id', digest: 'digest', offset: 3, total_characters: 7, complete: true, event: { body: '&gt;' } } },
  ]
  assert.equal(assembleNativePages(pages).body, '日本語&gt;')
  assert.equal(assembleNativePages(pages.slice(0, 1)), null)
  pages[1].page.offset = 4
  assert.throws(() => assembleNativePages(pages), { code: 'ACCEPTANCE_PAGE_NATIVE_SEQUENCE' })
})
test('公式parent_read包装からpageを読み、任意の本文復号をしない', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-scenarios-page-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'fixture.jsonl'), page = { schema: 'peertable.parent-read-page.v1', delivery_id: 'id', digest: 'd', offset: 0, total_characters: 4, complete: true, event: { body: '&gt;' } }
  writeFileSync(file, [JSON.stringify({ type: 'turn_context', payload: { turn_id: 't' } }), JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ schema: 'peertable.parent-read-result.v1', page }) }] }) } }), ''].join('\n'))
  const pages = nativeReadPages('codex', file, 'id')
  assert.equal(pages.length, 1); assert.equal(pages[0].turn_id, 't'); assert.equal(assembleNativePages(pages).body, '&gt;')
})
test('fixture proxyで実HTTP source断とreceipt障害を分け、復旧する', async t => {
  const backend = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, path: req.url })) })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  const proxy = await createScenarioProxy({ backend: `http://127.0.0.1:${backend.address().port}` })
  t.after(async () => { assert.deepEqual(await proxy.close(), { closed: true }); await new Promise(resolve => backend.close(resolve)) })
  assert.equal((await fetch(`${proxy.url}/api/room/messages`)).status, 200)
  proxy.disconnectSource()
  assert.equal((await fetch(`${proxy.url}/api/room/messages`)).status, 503)
  assert.equal((await fetch(`${proxy.url}/api/room/messages`, { method: 'POST', body: '{}' })).status, 200)
  proxy.reconnectSource(); proxy.failReceipts()
  assert.equal((await fetch(`${proxy.url}/api/room/messages`)).status, 200)
  assert.equal((await fetch(`${proxy.url}/api/room/deliveries`, { method: 'POST', body: '{}' })).status, 503)
  proxy.restoreReceipts()
  assert.equal((await fetch(`${proxy.url}/api/room/deliveries`, { method: 'POST', body: '{}' })).status, 200)
  assert.ok(proxy.events.some(item => item.kind === 'source_http_failed')); assert.ok(proxy.events.some(item => item.kind === 'receipt_http_failed'))
})
test('実行途中のfailureでも専用processのcleanupを呼ぶ', async () => {
  let finalized = null
  const actions = {
    package_inspect: async () => { throw Object.assign(new Error('試験境界'), { code: 'FIXTURE_FAILED' }) },
    deliver: async () => {}, package_observe: async () => {},
  }
  await assert.rejects(runScenario('package', { harness: 'claude', session: 'session', runId: 'run', pageChars: 100, actions, finalize: async scope => { finalized = scope } }), { code: 'FIXTURE_FAILED' })
  assert.equal(finalized.scenario, 'package'); assert.equal(finalized.runId, 'run')
})

test('no_tools: scopeの未収集checksと無関係に正常なClaude/Codex受信を認める', () => {
  for (const harness of ['claude', 'codex']) {
    const value = noToolsReception({ posted: { body: '日本語', nonce: '符号' }, record: { delivery_id: 'id', state: 'submitted', event: { body: '日本語' } }, receipt: { state: 'delivered' }, seen: { deliveries: [{ delivery_id: 'id', session: 's', turn_id: 't', body: '日本語', order: 1 }], replies: [{ session: 's', turn_id: 't2', order: 2, text: '符号' }] }, session: 's', runtime: 'armed', harness })
    assert.equal(value.state, 'native_received')
  }
})
test('no_tools: 原文を保った明示rearm_pendingを正常受信と区別する', () => {
  const value = noToolsReception({ posted: { body: '日本語', nonce: '符号' }, record: { delivery_id: 'id', state: 'ready', event: { body: '日本語' } }, receipt: null, seen: { deliveries: [], replies: [] }, session: 's', runtime: 'rearm_pending' })
  assert.equal(value.state, 'rearm_pending'); assert.equal(value.reply, null)
  assert.throws(() => noToolsReception({ posted: { body: '原文' }, record: { event: { body: '変更' } }, receipt: null, seen: { deliveries: [], replies: [] }, session: 's', runtime: 'rearm_pending' }), { code: 'ACCEPTANCE_NO_TOOLS_BODY_LOST' })
})
test('no_external_toolsは2通とidle新turnと次受信の維持を要求する', () => {
  const plan = scenarioPlan('no_external_tools')
  assert.equal(plan.filter(item => item.action === 'deliver').length, 2)
  assert.ok(plan.some(item => item.action === 'idle_wait'))
  assert.ok(plan.some(item => item.action === 'idle_observe'))
  assert.equal(plan.at(-1).expectation, 'native_receiving_maintained')
})
test('Codex busyは同turn・公式hook・到着時の実task状態を要求する', () => {
  const value = { workTurn: 'busy', delivery: { turn_id: 'busy', hook: 'post_tool_use', order: 3 }, record: { hook_turn: 'busy', hook_state: 'output_complete' }, turns: new Map([['busy', { started_order: 1, completed_order: 5 }]]) }
  assert.equal(assertCodexBusy(value).started_order, 1)
  assert.throws(() => assertCodexBusy({ ...value, delivery: { ...value.delivery, turn_id: 'idle-next' } }), { code: 'ACCEPTANCE_BUSY_CODEX_NATIVE_TURN' })
  assert.throws(() => assertCodexBusy({ ...value, delivery: { ...value.delivery, hook: null } }), { code: 'ACCEPTANCE_BUSY_CODEX_NATIVE_TURN' })
  assert.throws(() => assertCodexBusy({ ...value, turns: new Map([['busy', { started_order: 1, completed_order: 2 }]]) }), { code: 'ACCEPTANCE_BUSY_CODEX_NATIVE_TURN' })
})
test('Codex idleは過去のtask_completeを別turnへ流用しない', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-scenarios-turn-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'fixture.jsonl')
  writeFileSync(file, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'old' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'current' } },
  ].map(JSON.stringify).join('\n') + '\n')
  const turns = codexTurns(file)
  assert.equal(turns.get('old').completed_order, 1); assert.equal(turns.get('current').completed_order, null)
})

test('受信維持Shellは完成済み入力・実task ID・PID・所有相関が全て一致した場合だけ許可する', () => {
  const registration = { parent_session: 's', owner_verified: true, waiter_owner: { pid: 10, started: 'waiter-start' }, native_task: { id: 'task', pid: 20, process_identity: { pid: 20, started: 'task-start' }, input: { name: 'Shell', input: { command: 'exact-entry args', cwd: '/fixture' } } } }
  const use = { name: 'Shell', session: 's', input: { command: 'exact-entry args' }, hook_input: { command: 'exact-entry args', cwd: '/fixture' }, output: { shell_id: 'task', pid: 20 } }
  assert.equal(nativeReceiveToolAllowed(use, [registration], 's'), true)
  assert.equal(nativeReceiveToolAllowed({ ...use, hook_input: { command: 'unrelated-work', cwd: '/fixture' } }, [registration], 's'), false)
  assert.equal(nativeReceiveToolAllowed({ ...use, hook_input: { command: 'exact-entry args', cwd: '/別project' } }, [registration], 's'), false)
  assert.equal(nativeReceiveToolAllowed({ ...use, hook_input: undefined }, [registration], 's'), false)
  assert.equal(nativeReceiveToolAllowed({ ...use, output: { shell_id: 'other-task', pid: 20 } }, [registration], 's'), false)
  assert.equal(nativeReceiveToolAllowed({ ...use, session: 'other-session' }, [registration], 's'), false)
  assert.equal(nativeReceiveToolAllowed(use, [{ ...registration, owner_verified: false }], 's'), false)
})

test('全量readerは製品の実taskと公式Read/get出力の相関がある時だけ許可する', () => {
  const registration = { parent_session: 's', endpoint_id: 'endpoint', owner_verified: true, waiter_owner: { pid: 10, started: 'waiter' }, native_task: { id: 'task', process_identity: { pid: 20, started: 'task' }, input: { name: 'Shell' } } }
  const task = { id: 'task', reader_tool_use_id: 'read', session: 's', output_file: '/own/task.txt', result: { schema: 'peertable.parent-background-result.v1', endpoint_id: 'endpoint' } }
  const read = { id: 'read', name: 'Read', session: 's', input: { path: '/own/task.txt' } }
  assert.equal(nativeReceiveReaderAllowed(read, [registration], [task], 's'), true)
  assert.equal(nativeReceiveReaderAllowed({ ...read, input: { path: '/other/task.txt' } }, [registration], [task], 's'), false)
  assert.equal(nativeReceiveReaderAllowed({ ...read, input: { ...read.input, limit: 1 } }, [registration], [task], 's'), false)
  assert.equal(nativeReceiveReaderAllowed(read, [registration], [{ ...task, id: 'foreign' }], 's'), false)
  registration.native_task.input.name = 'run_terminal_command'
  const get = { ...read, name: 'get_command_or_subagent_output', input: { task_ids: ['task'] } }
  assert.equal(nativeReceiveReaderAllowed(get, [registration], [task], 's'), true)
  assert.equal(nativeReceiveReaderAllowed({ ...get, input: { ...get.input, timeout_ms: 1 } }, [registration], [task], 's'), false)
})


test('Cursorのidleは対象会話/generationの公式completed stopだけを採用する', () => {
  const last = { session: 'own', turn_id: '最新generation' }
  const entry = { pid: 123, event: { hook_event_name: 'stop', status: 'completed', conversation_id: 'own', generation_id: last.turn_id } }
  assert.equal(cursorIdleCompletion([entry], last, 'own'), entry)
  for (const changed of [{ generation_id: '過去generation' }, { conversation_id: '別会話' }, { status: 'aborted' }, { hook_event_name: 'postToolUse' }]) assert.equal(cursorIdleCompletion([{ ...entry, event: { ...entry.event, ...changed } }], last, 'own'), null)
  assert.equal(cursorIdleCompletion([{ event: {} }], last, 'own'), null)
  assert.throws(() => cursorIdleCompletion([entry], { ...last, session: '別会話' }, 'own'), { code: 'ACCEPTANCE_IDLE_NATIVE_END_MISSING' })
})

// 実runで確認した3欠陥(work-process拡張子・idle開始レース・burst観測レース)の最小再現。
test('用途名に拡張子を持つartifactはそのまま渡り、実Node scriptとして実行できる', async () => {
  const { artifactPath } = await import('./scenarios-context.mjs')
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'artifact-'))
  const script = artifactPath(dir, 'work-process.mjs')
  assert.equal(script, join(dir, 'work-process.mjs'))
  assert.equal(artifactPath(dir, 'work-start.json'), join(dir, 'work-start.json'))
  assert.equal(artifactPath(dir, '3-own_finite_lease'), join(dir, '3-own_finite_lease.json'))
  writeFileSync(script, "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'ok')\n")
  const out = join(dir, 'out.txt')
  assert.equal(spawnSync(process.execPath, [script, out]).status, 0)
  assert.equal(readFileSync(out, 'utf8'), 'ok')
})

test('idleはjoin後の親最終返答が会話に確定するまで基準にしない', async () => {
  const { finalReplyConfirmed } = await import('./scenarios-context.mjs')
  assert.equal(finalReplyConfirmed({ replies: [], pending_tail: 0 }), false)
  assert.equal(finalReplyConfirmed({ replies: [{ order: 1 }], pending_tail: 1 }), false)
  assert.equal(finalReplyConfirmed({ replies: [{ order: 1 }], pending_tail: 0 }), true)
})

test('burstは未読保持のspoolと同じoffsetまで返した実中間pageが揃うまで成立させない', async () => {
  const { intermediatePageMatch } = await import('./scenarios-context.mjs')
  const record = { state: 'sending', receipt: null, claim: { offset: 12000 }, event: { body: 'x'.repeat(24000) } }
  const page = (offset, length, complete) => ({ page: { offset, complete, event: { body: 'x'.repeat(length) } } })
  // spoolが先に更新され、transcriptにまだ中間pageが無い(実runで観測した順序)。
  assert.equal(intermediatePageMatch(record, []), null)
  assert.equal(intermediatePageMatch(record, [page(0, 6000, false)]), null)
  assert.equal(intermediatePageMatch(record, [page(0, 12000, false)]).page.offset, 0)
  // 最終pageや別offset、receipt済み・非sendingは未読保持ではない。
  assert.equal(intermediatePageMatch(record, [page(12000, 12000, true)]), null)
  assert.equal(intermediatePageMatch({ ...record, receipt: { result: 'delivered' } }, [page(0, 12000, false)]), null)
  assert.equal(intermediatePageMatch({ ...record, state: 'submitted' }, [page(0, 12000, false)]), null)
  assert.equal(intermediatePageMatch({ ...record, claim: { offset: 0 } }, [page(0, 12000, false)]), null)
})

test('Codex idleは返答表示直後のtask未完了を失敗にせず、task_complete記録まで待つ', async () => {
  const { codexTurnCompleted } = await import('./scenarios-context.mjs')
  const last = { turn_id: 'turn', order: 5 }
  const turns = ended => new Map([['turn', { turn_id: 'turn', started_order: 1, completed_order: ended?.order ?? null, end_kind: ended?.kind }]])
  assert.equal(codexTurnCompleted(turns(null), last), false)                               // 返答は出たがtaskは実行中
  assert.equal(codexTurnCompleted(turns({ order: 9, kind: 'turn_aborted' }), last), false)  // 中断は完了ではない
  assert.equal(codexTurnCompleted(turns({ order: 3, kind: 'task_complete' }), last), false) // 返答より前の完了は流用しない
  assert.equal(codexTurnCompleted(turns({ order: 9, kind: 'task_complete' }), last), true)
  assert.equal(codexTurnCompleted(new Map(), last), false)
})
