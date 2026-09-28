import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, linkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { ParentSpool, PAGE_CHARS, renderDelivery, digest, armParentState } from './parent-delivery.mjs'
import { processIdentity, processHarness, harnessProcess, readHookEvent, atomicJson } from './parent-platform.mjs'
import { queueCodex, codexHook, checkCodexReceiver } from './parent-receivers/codex.mjs'
import { mergeOwnedHooks, tomlHeaderKeys, replaceOwnedToml, ownedTomlBlock, hookEntries, ownsParentConnection, grokMcpBlock } from './parent-connect.mjs'
import { cursorEvent } from './parent-receivers/cursor.mjs'
import { clientHarness, hookContext, verifyHookCaller, verifyJoinHook, forgetEndpoint } from './parent-caller.mjs'
const fixture = t => {
  const project = mkdtempSync(join(tmpdir(), 'peertable spool 日本語 '))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const spool = ParentSpool.create(project, { endpoint_id: randomUUID(), start_seq: 0, name: 'bell', room: '試験', server_url: 'https://room.invalid', harness: 'grok', caller: { harness: 'grok', conversation: '同じ会話', owner: processIdentity(process.pid) } })
  // このfixtureは本文/claimを検証し、HTTP境界は遅延receiptとsource試験で検証する。
  spool.flushReceiptsAfterOutput = async () => {}
  return spool
}
const event = (seq, body = '日本語\n"引用"😀') => ({ type: 'parent_dm', seq, from: 'mio', to_names: ['bell', 'rui'], room: '試験', body, message: { seq, from: 'mio', to_names: ['bell', 'rui'], body } })

test('HTTP/SSE重複は同じ配送ID、原文保存後にcursorを進める', t => {
  const spool = fixture(t), original = event(1)
  const first = spool.saveEvent(original)
  assert.equal(spool.saveEvent(structuredClone(original)).delivery_id, first.delivery_id)
  assert.deepEqual(spool.read().records[0].event, original)
  assert.equal(spool.read().cursor, 0)
  spool.saveCursor(1, { last_seq: 1 })
  assert.equal(spool.read().cursor, 1)
  assert.match(renderDelivery(spool.read(), first), /日本語\n"引用"😀/u)
})

test('複数processのclaim競合は1通だけを所有し、孤児sendingはunknownで再送しない', async t => {
  const spool = fixture(t); spool.saveEvent(event(1)); spool.saveEvent(event(2))
  const url = new URL('./parent-delivery.mjs', import.meta.url).href
  const code = `import {ParentSpool} from ${JSON.stringify(url)}; const s=new ParentSpool(process.argv[1],process.argv[2]); console.log(JSON.stringify(s.claim('race')?.delivery_id??null));`
  const result = await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, spool.project, spool.id]); let out = '', err = ''
    child.stdout.on('data', data => { out += data }); child.stderr.on('data', data => { err += data })
    child.on('error', reject); child.on('close', status => status ? reject(new Error(err)) : resolve(JSON.parse(out)))
  })))
  assert.equal(result.filter(Boolean).length, 1)
  const recovered = spool.recover()
  assert.equal(recovered.records[0].state, 'unknown')
  assert.equal(recovered.records[0].event.body, event(1).body)
  assert.equal(spool.claim('next').event.seq, 2)
})

test('長文は継続tokenで原文全量を回収し、最後の出力完了までackしない', t => {
  const spool = fixture(t), body = 'あ'.repeat(PAGE_CHARS - 1) + '😀' + '\n"末尾"'.repeat(4000)
  const saved = spool.saveEvent(event(7, body)); let page = spool.page(saved.delivery_id), combined = ''
  assert.equal(spool.read().records[0].receipt, null)
  const tampered = page.result.continuation_token.replace(/^./u, 'x')
  assert.throws(() => spool.page(saved.delivery_id, tampered), /PARENT_CONTINUATION_INVALID/u)
  while (page) {
    combined += page.result.event.body
    const token = page.result.continuation_token
    spool.pageWritten(page)
    if (!token) break
    assert.equal(spool.read().records[0].state, 'sending')
    page = spool.page(saved.delivery_id, token)
  }
  assert.equal(combined, body)
  assert.equal(spool.read().records[0].state, 'submitted')
  assert.equal(spool.read().records[0].receipt.result, 'delivered')
})

test('handoff本文を同時readしても同じpageを二重出力しない', t => {
  const spool = fixture(t); spool.saveEvent(event(1)); const record = spool.claim('background'); spool.handoff(record)
  const page = spool.page(record.delivery_id)
  assert.throws(() => spool.page(record.delivery_id), /PARENT_READ_IN_PROGRESS/u)
  spool.pageWritten(page)
  assert.equal(spool.page(record.delivery_id), null)
})

test('page選択後に別出力がoffsetを進めた時、古いsnapshotを出力しない', t => {
  const spool = fixture(t); spool.saveEvent(event(1, 'あ'.repeat(PAGE_CHARS * 2)))
  const record = spool.claim('background'); spool.handoff(record)
  const transact = spool.transact.bind(spool)
  let interleave = true
  spool.transact = operation => {
    if (interleave) {
      interleave = false
      transact(state => { state.records[0].claim.offset = PAGE_CHARS })
    }
    return transact(operation)
  }
  assert.throws(() => spool.page(record.delivery_id), /PARENT_CONTINUATION_MISMATCH/u)
  assert.equal(spool.read().records[0].claim.page_inflight, undefined)
})

test('別MCP processがpage出力前に終了すると原文/offset/受付を保持したunknownへ回収する', async t => {
  const spool = fixture(t); spool.saveEvent(event(1, '長文'.repeat(PAGE_CHARS))); const record = spool.claim('background'); spool.handoff(record)
  const url = new URL('./parent-delivery.mjs', import.meta.url).href
  const code = `import {ParentSpool} from ${JSON.stringify(url)};const s=new ParentSpool(process.argv[1],process.argv[2]);const page=s.page(process.argv[3]);console.log(page.result.delivery_id);`
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, spool.project, spool.id, record.delivery_id]); let err = ''
    child.stdout.resume(); child.stderr.on('data', data => { err += data }); child.on('error', reject); child.on('close', code => code ? reject(new Error(err)) : resolve())
  })
  const before = spool.read().records[0]
  assert.ok(before.claim.page_owner.pid !== process.pid); assert.equal(before.claim.offset, 0)
  const recovered = spool.recover().records[0]
  assert.equal(recovered.state, 'unknown'); assert.equal(recovered.error_code, 'PARENT_PAGE_OUTPUT_INTERRUPTED')
  assert.equal(recovered.event.body, '長文'.repeat(PAGE_CHARS)); assert.equal(recovered.claim.offset, 0)
  assert.equal(spool.page(record.delivery_id), null)
  assert.equal(recovered.receipt.result, 'unknown')
})

test('queue受付後unknownへ変わっても受付証拠を保持し、receiptだけを再試行する', async t => {
  const spool = fixture(t); spool.saveEvent(event(1)); const record = spool.claim('codex_queue')
  spool.finish(record, { queued_submission_id: 'queue-official-id', accepted_at: '2026-09-28T00:00:00Z' })
  spool.finish(record, { state: 'unknown', reason: 'queue_delete_then_output_interrupted' })
  await assert.rejects(spool.flushReceipts({ request: async () => { throw new Error('offline') } }), /offline/u)
  const posted = []
  await spool.flushReceipts({ request: async (path, args) => posted.push(args.body) })
  assert.equal(posted[0].result, 'unknown'); assert.equal(posted[0].queued_submission_id, 'queue-official-id')
  assert.equal(posted[0].accepted_at, '2026-09-28T00:00:00Z')
  assert.equal(spool.claim('retry'), null)
  assert.equal(spool.read().records[0].receipt.pending, false)
})

test('古いreceiptの遅延HTTP失敗は新しいreceiptの成功診断を上書きしない', async t => {
  const spool = fixture(t); spool.saveEvent(event(1)); const record = spool.claim('fixture'); spool.finish(record)
  let rejectOld
  const failure = Object.assign(new Error('遅延失敗'), { code: 'HTTP_FAILURE' })
  const old = spool.flushReceipts({ request: () => new Promise((resolve, reject) => { rejectOld = reject }) })
  const rejected = assert.rejects(old, /遅延失敗/u)
  spool.finish(record, { state: 'unknown', reason: 'OUTPUT_INTERRUPTED' })
  await spool.flushReceipts({ request: async () => ({ ok: true }) })
  rejectOld(failure); await rejected
  assert.equal(spool.read().receipt_error, null)
  assert.equal(spool.read().records[0].receipt.pending, false)
})

test('未知clientとshell引数内のharness名を本人へ推測割当しない', () => {
  assert.throws(() => clientHarness({ name: 'not-codex-but-contains-codex' }), /未確認/u)
  assert.equal(clientHarness({ name: 'codex-mcp-client' }), 'codex')
  assert.equal(clientHarness({ name: 'claude-code' }), 'claude')
  assert.equal(clientHarness({ name: 'cursor-vscode 2.6.0' }), 'cursor')
  assert.throws(() => clientHarness({ name: 'cursor-vscode-fake' }), /未確認/u)
  assert.equal(clientHarness({ name: 'grok-shell-peertable_parent' }), 'grok')
  assert.equal(processHarness({ executable: '/bin/zsh', command: 'zsh -c "codex app-server"' }), null)
  assert.equal(processHarness({ executable: '/usr/bin/node', command: 'node script.mjs claude /Cursor.app' }), null)
  assert.equal(processHarness({ executable: '/usr/bin/node', command: 'node /global/node_modules/@openai/codex/bin/codex.js app-server' }), 'codex')
})

test('CursorのNode optionとGrok公式native名を認識し、preloadや評価式を本人にしない', () => {
  const node = process.execPath
  const cursor = '/home/kite/.local/share/cursor-agent/versions/2026.09.26-dd393fe/index.js'
  assert.equal(processHarness({ executable: node, command: `node --use-system-ca ${cursor} --model auto` }), 'cursor')
  assert.equal(processHarness({ executable: node, command: `node --require ${cursor} script.mjs` }), null)
  assert.equal(processHarness({ executable: node, command: `node --eval "${cursor}"` }), null)
  assert.equal(processHarness({ executable: '/home/kite/.grok/downloads/grok-linux-x86_64', command: 'grok --always-approve' }), 'grok')
  assert.equal(processHarness({ executable: '/home/kite/.grok/downloads/grok-macos-aarch64', command: 'grok' }), 'grok')
  assert.equal(processHarness({ executable: '/home/kite/.grok/downloads/grok-1.0.41-linux-x86_64', command: 'grok --always-approve' }), 'grok')
  assert.equal(processHarness({ executable: '/home/kite/.grok/downloads/grok-1.0.41-macos-aarch64', command: 'grok' }), 'grok')
  assert.equal(processHarness({ executable: '/tmp/grok-1.0.41-unknown-x86_64', command: 'grok' }), null)
  assert.equal(processHarness({ executable: '/tmp/grok-unknown-name', command: 'grok' }), null)
})

test('harness探索はPID 1とexecutableのないsystem祖先を照会しない', () => {
  const calls = []
  assert.equal(harnessProcess('grok', 2, { identify: (pid, options) => {
    calls.push([pid, options?.includeExecutable !== false])
    assert.notEqual(pid, 1)
    return { pid, parent: 1, started: 'fixture', executable: '/bin/sh', command: 'sh' }
  } }), null)
  assert.deepEqual(calls, [[2, false], [2, true]])
  assert.equal(harnessProcess('cursor', 4, { identify: (pid, options) => {
    assert.equal(options?.includeExecutable, false)
    return { pid, parent: 0, started: 'system', executable: null, command: null }
  } }), null)
})

test('公式hookのBOMとUTF-8文字途中の分割を受け、壊れたJSONは明示失敗する', async () => {
  const expected = { hook_event_name: 'preToolUse', conversation_id: '会話😀', tool_input: { body: '日本語\n「引用」😀' } }
  const bytes = Buffer.from(`\uFEFF${JSON.stringify(expected)}`)
  assert.deepEqual(await readHookEvent(Readable.from([...bytes].map(byte => Buffer.from([byte])))), expected)
  await assert.rejects(readHookEvent(Readable.from([Buffer.from('{破損')])) , { code: 'PARENT_HOOK_INPUT_INVALID' })
})

test('Cursor afterMCPExecutionはtool_use_idなしでもendpointと実会話・開始identityを照合する', t => {
  const spool = fixture(t), owner = processIdentity(process.pid)
  spool.update({ caller: { harness: 'cursor', conversation: 'この会話', owner } })
  const result = { schema: 'peertable.parent-join-result.v1', endpoint_id: spool.id }
  const event = { hook_event_name: 'afterMCPExecution', conversation_id: 'この会話', mcp_server_name: 'peertable_parent', tool_name: 'parent_join', result_json: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }) }
  const options = { resolveEndpoint: id => { assert.equal(id, spool.id); return spool } }
  assert.deepEqual(verifyJoinHook('cursor', event, owner, options), result)
  assert.throws(() => verifyJoinHook('cursor', { ...event, conversation_id: '別会話' }, owner, options), { code: 'PARENT_CALLER_MISMATCH' })
  assert.throws(() => verifyJoinHook('cursor', event, { ...owner, started: '別開始' }, options), { code: 'PARENT_CALLER_MISMATCH' })
  assert.equal(verifyJoinHook('cursor', { ...event, mcp_server_name: 'other' }, owner, options), null)
})

test('事前hookの本人相関期限は本人不一致と区別する', () => {
  const input = { project: '/専用試験', name: 'bell' }
  for (const harness of ['claude', 'cursor', 'grok']) {
    const context = { harness, name: 'parent_join', input_digest: digest(input), owner: processIdentity(process.pid), created_at: Date.now() }
    assert.doesNotThrow(() => verifyHookCaller(context, harness, 'parent_join', input))
    const expired = { ...context, created_at: Date.now() - 30001 }
    assert.throws(() => verifyHookCaller(expired, harness, 'parent_join', input), { code: 'PARENT_BIND_TIMEOUT' })
    assert.throws(() => verifyHookCaller(expired, harness, 'parent_join', { ...input, name: '別人' }), { code: 'PARENT_CALLER_MISMATCH' })
  }
})

test('probe期限は受信準備から始め、確認済みprobeだけが自身の期限エラーを解除する', t => {
  const spool = fixture(t)
  spool.update({ created_at: '2000-01-01T00:00:00.000Z' })
  spool.slot('grok_background')
  assert.equal(spool.read().probe_deadline, undefined)
  const before = Date.now()
  spool.transact(armParentState)
  assert.ok(spool.read().probe_deadline >= before + 30000)
  const probe = spool.saveEvent({ type: 'parent_probe', event_id: 'probe', body: '疎通確認' })
  const claimed = spool.claim('grok_background', probe.delivery_id)
  spool.update({ state: 'failed', runtime: 'failed', error_code: 'PARENT_PROBE_TIMEOUT' })
  spool.finish(claimed)
  assert.equal(spool.read().state, 'verified')
  assert.equal(spool.read().runtime, 'armed')
  assert.equal(spool.read().error_code, null)
  const other = spool.saveEvent(event(9)), record = spool.claim('grok_background', other.delivery_id)
  spool.update({ error_code: 'PARENT_PROCESS_API_FAILED' }); spool.finish(record)
  assert.equal(spool.read().error_code, 'PARENT_PROCESS_API_FAILED')
})

test('project hookの親は別packageのglobal接続を所有せず、解除済み接続も撤去しない', t => {
  const spool = fixture(t), home = join(spool.project, 'receiver-home'), file = join(home, 'connections', 'cursor.json')
  assert.equal(ownsParentConnection('cursor', { home }), false)
  atomicJson(file, { status: 'registered', commands: ['他packageのhook'] })
  assert.equal(ownsParentConnection('cursor', { home }), false)
  const commands = Object.values(hookEntries('cursor')).flatMap(groups => groups.map(group => JSON.stringify([group.command, []])))
  atomicJson(file, { status: 'registered', commands })
  assert.equal(ownsParentConnection('cursor', { home }), true)
  atomicJson(file, { status: 'removed', commands })
  assert.equal(ownsParentConnection('cursor', { home }), false)
})

test('親の撤去は本文を保持し、共有会話・未消費要求・別の開始identityを消さない', t => {
  const spool = fixture(t), home = join(spool.project, 'receiver-home'), index = join(home, 'endpoints', `${spool.id}.json`)
  spool.saveEvent(event(1)); spool.update({ runtime: 'stopped' })
  const caller = spool.read().caller, consumed = join(home, 'contexts', `own.json.consumed-${randomUUID()}`)
  const pending = join(home, 'contexts', 'pending.json'), foreign = join(home, 'contexts', 'foreign.json'), joined = join(home, 'join-results', 'own.json')
  atomicJson(index, { endpoint_id: spool.id, project: spool.project })
  atomicJson(consumed, caller); atomicJson(pending, caller); atomicJson(foreign, { ...caller, owner: { ...caller.owner, started: '別の開始' } }); atomicJson(joined, { caller })
  forgetEndpoint(spool, { home, activeEndpoints: () => [{ read: () => ({ runtime: 'armed', caller }) }] })
  assert.equal(existsSync(index), false); assert.equal(existsSync(consumed), true)
  forgetEndpoint(spool, { home, activeEndpoints: () => [] })
  assert.equal(existsSync(consumed), false); assert.equal(existsSync(joined), false)
  assert.equal(existsSync(pending), true); assert.equal(existsSync(foreign), true)
  assert.equal(spool.read().records[0].event.body, event(1).body)
  const stoppedCaller = { ...caller, owner: { ...caller.owner, started: '終了した開始' } }
  spool.update({ caller: stoppedCaller }); atomicJson(pending, stoppedCaller)
  forgetEndpoint(spool, { home, activeEndpoints: () => [] })
  assert.equal(existsSync(pending), false); assert.equal(existsSync(foreign), true)
})

test('Claude agent_id付き会話は相関保存前に明示拒否する', () => {
  assert.throws(() => hookContext('claude', { agent_id: 'native-agent', session_id: 'session', tool_use_id: 'use', tool_name: 'parent_join', tool_input: {} }), { code: 'CLAUDE_PARENT_SUBAGENT_UNSUPPORTED' })
})

test('Codex native thread_spawnはqueue/hookの健康確認へ進む前に明示拒否する', async () => {
  const calls = []; let closed = false
  await assert.rejects(checkCodexReceiver('.', { conversation: 'native-child' }, 'owned-hook', { connect: async () => ({
    request: async method => { calls.push(method); return { thread: { id: 'native-child', source: { subAgent: { thread_spawn: {} } } } } },
    close: async () => { closed = true },
  }) }), { code: 'CODEX_PARENT_UNSUPPORTED' })
  assert.deepEqual(calls, ['thread/read']); assert.equal(closed, true)
})

test('TOML literal/basic quoted own tableの置換は他設定の字面と順序を保持する', () => {
  const text = '#利用者\n[mcp_servers.other]\ncommand="other"\n[mcp_servers.\'peertable_parent\']\ncommand="ours"\n[hooks.state.\'C:\\path:key\']\nenabled=true\n'
  assert.deepEqual(tomlHeaderKeys("[hooks.state.'C:\\path:key']"), ['hooks', 'state', 'C:\\path:key'])
  const owned = ownedTomlBlock(text).block
  assert.throws(() => replaceOwnedToml(text, ''), /PARENT_CONFIG_OWNERSHIP_CONFLICT/u)
  assert.equal(replaceOwnedToml(text, '', digest(owned)), '#利用者\n[mcp_servers.other]\ncommand="other"\n[hooks.state.\'C:\\path:key\']\nenabled=true\n')
})

test('hook更新は外部の順序・承認・入力を保持する', () => {
  const foreign = { hooks: [{ type: 'command', command: '利用者のhook', enabled: true }] }
  const ours = { hooks: [{ command: '自分のhook' }] }
  const next = mergeOwnedHooks({ permissions: { allow: ['read'] }, hooks: { Stop: [foreign, ours, foreign] } }, { Stop: [{ hooks: [{ command: '新hook' }] }] }, [JSON.stringify(['自分のhook', []])])
  assert.deepEqual(next.hooks.Stop[0], foreign); assert.deepEqual(next.hooks.Stop[2], foreign)
  assert.deepEqual(next.permissions, { allow: ['read'] })
})

test('GrokのMCP登録解除はLF末尾の外部TOMLへ空行を追加しない', () => {
  for (const before of ['', '# 利用者の設定\nmodel = "grok"\n', '# 利用者の空行も保持\n\n\n']) {
    const added = replaceOwnedToml(before, grokMcpBlock({ command: '/空白 dir/node', args: ['日本語', 'parent'] }))
    const removed = replaceOwnedToml(added, '', digest(ownedTomlBlock(added).block))
    assert.equal(removed, before)
  }
})

test('hook解除は導入した空のevent/containerを撤去し、利用者の空eventと最新の編集を残す', () => {
  const pristine = { permissions: { allow: ['read'] } }
  const original = { keys: Object.keys(pristine), event_names: [] }
  const ours = { hooks: [{ command: '専用hook' }] }, commands = [JSON.stringify(['専用hook', []])]
  const registered = mergeOwnedHooks(pristine, { PreToolUse: [ours], Stop: [ours] }, commands, original)
  assert.deepEqual(mergeOwnedHooks(registered, {}, commands, original), pristine)
  const latest = { ...registered, language: '日本語', hooks: { ...registered.hooks, UserPromptSubmit: [] } }
  assert.deepEqual(mergeOwnedHooks(latest, {}, commands, original), { ...pristine, language: '日本語', hooks: { UserPromptSubmit: [] } })
  const originallyEmpty = { hooks: { Stop: [] } }, shape = { keys: ['hooks'], event_names: ['Stop'] }
  const added = mergeOwnedHooks(originallyEmpty, { Stop: [ours], PreToolUse: [ours] }, commands, shape)
  assert.deepEqual(mergeOwnedHooks(added, {}, commands, shape), originallyEmpty)
})

test('別hostが正式endpointを置き換えると旧本文を新会話へ移さず旧receiverを閉じる', async t => {
  const spool = fixture(t); spool.saveEvent(event(1)); const replacement = randomUUID()
  await assert.rejects(spool.assertCurrentEndpoint({ members: async () => [{ name: 'bell', delivery: { kind: 'parent_receiver', endpoint_id: replacement } }] }), /PARENT_ENDPOINT_SUPERSEDED/u)
  assert.equal(spool.read().runtime, 'stopped'); assert.equal(spool.read().records[0].state, 'failed')
  assert.equal(spool.read().records[0].event.body, event(1).body)
  assert.equal(spool.claim('旧会話への配送'), null)
})

test('queueの明示拒否はfailed、応答不明はunknownになる', async t => {
  for (const rejected of [true, false]) {
    const spool = fixture(t); spool.saveEvent(event(1))
    const error = Object.assign(new Error('RPC失敗'), { code: rejected ? 'PARENT_CODEX_RPC_REJECTED' : 'PARENT_CODEX_DISCONNECTED', rpc_rejected: rejected })
    await assert.rejects(queueCodex(spool, { checkTarget: async () => {}, connect: async () => ({ request: async () => { throw error }, close: async () => {} }) }), /RPC失敗/u)
    assert.equal(spool.read().records[0].state, rejected ? 'failed' : 'unknown')
  }
})

test('queue受付保存より先にhookが削除・出力失敗しても遅延受付はunknownを消さない', async t => {
  const spool = fixture(t); spool.saveEvent(event(1))
  let accept, invoked
  const started = new Promise(resolve => { invoked = resolve })
  const queueing = queueCodex(spool, { checkTarget: async () => {}, connect: async () => ({ request: async () => { invoked(); return new Promise(resolve => { accept = resolve }) }, close: async () => {} }) })
  await started
  const saved = spool.read().records[0], deleted = []
  const hookClient = { request: async (method, args) => method === 'thread/queue/list' ? { data: [
    { id: 'foreign-id', clientUserMessageId: 'foreign-message', input: [{ type: 'text', text: '他製品' }] },
    { id: 'official-accepted', clientUserMessageId: saved.delivery_id, input: [{ type: 'text', text: saved.queue_text }] },
  ] } : (deleted.push(args.queuedSubmissionId), { deleted: true }), close: async () => {} }
  await assert.rejects(codexHook(spool, { session_id: '同じ会話', hook_event_name: 'PostToolUse' }, async () => { throw new Error('出力断') }, { checkTarget: async () => {}, connect: async () => hookClient }), /出力断/u)
  assert.deepEqual(deleted, ['official-accepted'])
  accept({ queuedSubmission: { id: 'official-accepted' } }); await queueing
  const result = spool.read().records[0]
  assert.equal(result.state, 'unknown'); assert.equal(result.queued_submission_id, 'official-accepted')
  assert.equal(result.receipt.result, 'unknown'); assert.equal(result.hook_state, 'deleted')
})

test('hardlink後・削除後の実child終了は受付証拠を残してunknownになる', async t => {
  const deliveryUrl = new URL('./parent-delivery.mjs', import.meta.url).href, platformUrl = new URL('./parent-platform.mjs', import.meta.url).href
  for (const phase of ['before_state_save', 'deleted']) {
    const spool = fixture(t); spool.saveEvent(event(1)); const record = spool.claim('codex_queue')
    spool.transact(state => { const item = spool.owned(state, record); item.queue_digest = 'same-digest'; item.queue_thread = '同じ会話' })
    spool.finish(record, { queued_submission_id: 'official-accepted', accepted_at: '2026-09-28T00:00:00Z' })
    const code = `import {ParentSpool} from ${JSON.stringify(deliveryUrl)};import {atomicJson,processIdentity} from ${JSON.stringify(platformUrl)};import {mkdirSync,linkSync} from 'node:fs';import {randomUUID} from 'node:crypto';const s=new ParentSpool(process.argv[1],process.argv[2]);const record=s.read().records[0];const claim={id:randomUUID(),delivery_id:record.delivery_id,endpoint_id:s.id,digest:'same-digest',owner:processIdentity(process.pid)};mkdirSync(s.root+'/queue-claims');const candidate=s.root+'/queue-claims/candidate.json';atomicJson(candidate,claim);linkSync(candidate,s.root+'/queue-claims/'+record.delivery_id+'.json');if(process.argv[3]==='deleted')s.transact(state=>{const item=s.owned(state,record);item.hook_claim=claim;item.hook_state='deleted'});`
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, spool.project, spool.id, phase]); let err = ''
      child.stderr.on('data', data => { err += data }); child.on('error', reject); child.on('close', code => code ? reject(new Error(err)) : resolve())
    })
    const recovered = spool.recover().records[0]
    assert.equal(recovered.state, 'unknown'); assert.equal(recovered.receipt.queued_submission_id, 'official-accepted')
    assert.equal(recovered.event.body, event(1).body); assert.equal(spool.claim('自動再送'), null)
  }
})

test('ClaudeのPost/Stop同時開始は同じsessionで1slot、期限controlは本文成功にしない', async t => {
  const spool = fixture(t), gate = join(spool.root, 'gate')
  const deliveryUrl = new URL('./parent-delivery.mjs', import.meta.url).href, receiverUrl = new URL('./parent-receivers/claude.mjs', import.meta.url).href
  const code = `import {ParentSpool} from ${JSON.stringify(deliveryUrl)};import {claudeRewake} from ${JSON.stringify(receiverUrl)};import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';const s=new ParentSpool(process.argv[1],process.argv[2]);console.log('準備');while(!fs.existsSync(process.argv[3]))await delay(10);let outputs=[];const status=await claudeRewake(s,async text=>outputs.push(text),{leaseMs:500,slotRoot:s.root+'/slots',listEndpoints:()=>[]});console.log(JSON.stringify({status,outputs}));`
  let ready = 0
  const result = await Promise.all(Array.from({ length: 2 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, spool.project, spool.id, gate]); let out = '', err = ''
    child.stdout.on('data', data => { out += data; if (out.includes('準備') && !child.readyReported) { child.readyReported = true; if (++ready === 2) writeFileSync(gate, '') } })
    child.stderr.on('data', data => { err += data }); child.on('error', reject)
    child.on('close', status => status ? reject(new Error(err)) : resolve(JSON.parse(out.trim().split('\n').at(-1))))
  })))
  assert.deepEqual(result.map(item => item.status).sort(), [0, 2])
  assert.match(result.find(item => item.status === 2).outputs[0], /PARENT_RECEIVER_EXPIRED/u)
  assert.equal(spool.read().runtime, 'rearm_pending'); assert.equal(spool.read().records.length, 0)
})

test('Cursor afterMCPExecutionとpostToolUseは同じclaimを共有しbusy本文を1回だけ出す', async t => {
  assert.ok(hookEntries('cursor').afterMCPExecution)
  const spool = fixture(t); spool.saveEvent(event(1)); const output = []
  const options = { checkTarget: async () => {} }
  const native = { hook_event_name: 'afterMCPExecution', conversation_id: '同じ会話', tool_use_id: 'official-use-id', mcp_server_name: 'peertable_parent', tool_name: 'parent_read', tool_input: '{"endpoint_id":"returned-endpoint"}', result_json: '{"content":[]}' }
  const results = await Promise.all([cursorEvent(spool, native, async value => output.push(value), options), cursorEvent(spool, { ...native, hook_event_name: 'postToolUse', tool_name: 'MCP:parent_read', tool_input: { endpoint_id: 'returned-endpoint' } }, async value => output.push(value), options)])
  assert.equal(results.filter(Boolean).length, 1); assert.equal(output.length, 1)
  assert.match(output[0].additional_context, /日本語\n"引用"😀/u)
  assert.equal(spool.read().records[0].receipt.result, 'delivered')
})
