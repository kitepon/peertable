import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'

// 配送の記録（~/.peertable/parent-receivers）は試験用のHOMEへ置く。
const home = mkdtempSync(join(tmpdir(), 'peertable-parent-home-'))
process.env.HOME = home; process.env.USERPROFILE = home
test.after(() => rmSync(home, { recursive: true, force: true }))

const { ParentSpool, renderDelivery, digest } = await import('./parent-delivery.mjs')
const { processIdentity, processHarness, harnessProcess, readHookEvent } = await import('./parent-platform.mjs')
const { tomlHeaderKeys, replaceOwnedToml, ownedTomlBlock, grokMcpBlock, removeLegacyHooks, codexOwnedEntry } = await import('./parent-connect.mjs')
const { clientHarness } = await import('./parent-caller.mjs')
const { PEERTABLE_PROFILE, steer } = await import('./parent-steer.mjs')

const fixture = (t, harness = 'grok') => {
  const project = mkdtempSync(join(tmpdir(), 'peertable spool 日本語 '))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const spool = ParentSpool.create(project, { endpoint_id: randomUUID(), start_seq: 0, name: 'bell', room: '試験', server_url: 'https://room.invalid', harness, caller: { harness, owner: processIdentity(process.pid) } })
  // このfixtureは本文と配送状態を検証する。roomへのHTTPは別の試験で通す。
  spool.flushReceiptsAfterOutput = async () => {}
  return spool
}
const event = (seq, body = '日本語\n"引用"😀') => ({ type: 'parent_dm', seq, from: 'mio', to_names: ['bell', 'rui'], room: '試験', body, message: { seq, from: 'mio', to_names: ['bell', 'rui'], body } })
const claudeParent = session => {
  const hookRoot = steer.claudeHookRoot(PEERTABLE_PROFILE), request = `toolu_${randomUUID().replace(/-/gu, '')}`
  const self = steer.readRuntimeProcesses().find(row => row.pid === process.pid)
  mkdirSync(join(hookRoot, request), { recursive: true })
  writeFileSync(join(hookRoot, request, 'request.json'), JSON.stringify({ request_id: request, session_id: session, agent_id: null, parent_pid: process.pid, parent_started_identity: self.started_identity }))
  return { kind: 'claude', request_id: request, session_id: session, hook_root: hookRoot }
}

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

test('古いreceiptの遅延HTTP失敗は新しいreceiptの成功診断を上書きしない', async t => {
  const spool = fixture(t), record = spool.saveEvent(event(1))
  spool.settle(record.delivery_id, 'submitted', 'fixture')
  let rejectOld
  const old = spool.flushReceipts({ request: () => new Promise((resolve, reject) => { rejectOld = reject }) })
  await new Promise(resolve => setTimeout(resolve, 10))
  spool.settle(record.delivery_id, 'unknown', 'OUTPUT_INTERRUPTED')
  await spool.flushReceipts({ request: async () => ({ ok: true }) })
  rejectOld(Object.assign(new Error('old'), { code: 'OLD' }))
  await assert.rejects(old, /old/u)
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

test('TOML literal/basic quoted own tableの置換は他設定の字面と順序を保持する', () => {
  const text = '#利用者\n[mcp_servers.other]\ncommand="other"\n[mcp_servers.\'peertable_parent\']\ncommand="ours"\n[hooks.state.\'C:\\path:key\']\nenabled=true\n'
  assert.deepEqual(tomlHeaderKeys("[hooks.state.'C:\\path:key']"), ['hooks', 'state', 'C:\\path:key'])
  const owned = ownedTomlBlock(text).block
  assert.throws(() => replaceOwnedToml(text, ''), /PARENT_CONFIG_OWNERSHIP_CONFLICT/u)
  assert.equal(replaceOwnedToml(text, '', digest(owned)), '#利用者\n[mcp_servers.other]\ncommand="other"\n[hooks.state.\'C:\\path:key\']\nenabled=true\n')
})

test('Codexが読み戻しで足す既定値は所有の照合に含めない', () => {
  const registration = { command: '/usr/bin/node', args: ['/pt/room/client.mjs', 'parent'] }
  // Codex 0.158のconfig/readが返す形。
  const readBack = { ...registration, environment_id: 'local', enabled: true, tool_timeout_sec: null }
  assert.equal(digest(codexOwnedEntry(readBack)), digest(registration))
  // 利用者が変えた値は残り、照合で衝突になる。
  assert.notEqual(digest(codexOwnedEntry({ ...readBack, enabled: false })), digest(registration))
  assert.notEqual(digest(codexOwnedEntry({ ...readBack, env: { A: '1' } })), digest(registration))
  assert.notEqual(digest(codexOwnedEntry({ ...readBack, environment_id: 'remote' })), digest(registration))
})

test('GrokのMCP登録解除はLF末尾の外部TOMLへ空行を追加しない', () => {
  for (const before of ['', '# 利用者の設定\nmodel = "grok"\n', '# 利用者の空行も保持\n\n\n']) {
    const added = replaceOwnedToml(before, grokMcpBlock({ command: '/空白 dir/node', args: ['日本語', 'parent'] }))
    const removed = replaceOwnedToml(added, '', digest(ownedTomlBlock(added).block))
    assert.equal(removed, before)
  }
})

test('背景受信の親へ到着順に送り、受け取られた本文だけをdeliveredにする', async t => {
  const spool = fixture(t)
  spool.rebind(steer.openChannel(PEERTABLE_PROFILE, null), spool.read().caller)
  const first = spool.saveEvent(event(1, '一通目')), second = spool.saveEvent(event(2, '二通目\n改行'))
  await spool.deliverReady()
  assert.deepEqual(spool.read().records.map(record => record.state), ['sending', 'sending'])
  const received = await steer.receiveFromChannel(PEERTABLE_PROFILE, spool.read().channel.channel_id, { poll_ms: 10 })
  assert.deepEqual(received.deliveries.map(item => item.text), [renderDelivery(spool.read(), first), renderDelivery(spool.read(), second)])
  spool.syncStates()
  const records = spool.read().records
  assert.deepEqual(records.map(record => record.state), ['submitted', 'submitted'])
  assert.deepEqual(records.map(record => [record.receipt.result, record.receipt.reason, record.receipt.seq]), [['delivered', 'background_receiver_output', 1], ['delivered', 'background_receiver_output', 2]])
})

test('張り直すと、前のchannelでまだ受け取られていない本文を新しいchannelで送る', async t => {
  const spool = fixture(t)
  spool.rebind(steer.openChannel(PEERTABLE_PROFILE, null), spool.read().caller)
  const before = spool.read().channel.channel_id
  spool.saveEvent(event(1)); await spool.deliverReady()
  spool.rebind(steer.openChannel(PEERTABLE_PROFILE, null), spool.read().caller)
  assert.notEqual(spool.read().channel.channel_id, before)
  assert.equal(spool.read().records[0].state, 'ready')
  assert.equal(steer.channelClosed(PEERTABLE_PROFILE, before), true)
  await spool.deliverReady()
  const received = await steer.receiveFromChannel(PEERTABLE_PROFILE, spool.read().channel.channel_id, { poll_ms: 10 })
  assert.equal(received.deliveries.length, 1)
  spool.syncStates()
  assert.equal(spool.read().records[0].state, 'submitted')
})

test('Claudeの親へはasync hookの待機が本文を出し、2通目以降も次の待機で届く', async t => {
  const spool = fixture(t, 'claude'), session = randomUUID()
  spool.rebind(steer.openChannel(PEERTABLE_PROFILE, claudeParent(session)), spool.read().caller)
  spool.saveEvent(event(1, 'room発言')); await spool.deliverReady()
  const out = []
  assert.equal(await steer.runClaudeChannelWaiter(PEERTABLE_PROFILE, { session_id: session }, text => { out.push(text) }, { poll_ms: 10 }), 2)
  spool.saveEvent(event(2, '二通目')); await spool.deliverReady()
  assert.equal(await steer.runClaudeChannelWaiter(PEERTABLE_PROFILE, { session_id: session }, text => { out.push(text) }, { poll_ms: 10 }), 2)
  assert.match(out[0], /room発言/u); assert.match(out[1], /二通目/u)
  spool.syncStates()
  assert.deepEqual(spool.read().records.map(record => record.receipt.reason), ['claude_asyncRewake_output', 'claude_asyncRewake_output'])
})

test('Cursorの親はjoin結果の印で会話へ結ばれ、作業中は次のtool返りへ差し込まれる', async t => {
  const spool = fixture(t, 'cursor')
  const channel = steer.openChannel(PEERTABLE_PROFILE, { kind: 'cursor' })
  spool.rebind(channel, spool.read().caller)
  const marker = steer.channelMarker(channel)
  await steer.handleCursorChannelHook(PEERTABLE_PROFILE, { hook_event_name: 'afterMCPExecution', conversation_id: 'c1', tool_name: 'MCP:parent_join', result_json: JSON.stringify({ content: [{ type: 'text', text: `{}\n${marker.text}` }] }) }, () => assert.fail('束縛だけ'))
  spool.saveEvent(event(1, '作業中の発言')); await spool.deliverReady()
  const out = []
  assert.equal(await steer.handleCursorChannelHook(PEERTABLE_PROFILE, { hook_event_name: 'postToolUse', conversation_id: 'c1', tool_output: '{}' }, text => { out.push(text) }), true)
  assert.match(out[0], /作業中の発言/u)
  spool.syncStates()
  assert.equal(spool.read().records[0].receipt.reason, 'cursor_hook_output')
})

test('閉じたchannelへの送信は送っていない失敗としてroomへ返す', async t => {
  const spool = fixture(t)
  const channel = steer.openChannel(PEERTABLE_PROFILE, null)
  spool.rebind(channel, spool.read().caller)
  steer.closeChannel(PEERTABLE_PROFILE, channel.channel_id)
  spool.saveEvent(event(1)); await spool.deliverReady()
  assert.equal(spool.read().records[0].state, 'failed')
  assert.deepEqual([spool.read().records[0].receipt.result, spool.read().receipt_error ?? null], ['failed', null])
})

test('旧方式のhook（parent-hook.mjs）だけを取り除き、利用者と他製品のhookを残す', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-legacy-hooks-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')
  const aiterm = { type: 'command', command: '/usr/bin/node', args: ['/opt/aiterm/dist/claude-parent-hook.js'] }
  writeFileSync(file, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: '/usr/bin/node', args: ['/opt/peertable/skill/scripts/parent-hook.mjs', 'claude'] }, aiterm] }],
    Stop: [{ hooks: [{ type: 'command', command: "'/usr/bin/node' '/opt/peertable/skill/scripts/parent-hook.mjs' 'claude'" }] }],
  }, keep: true }))
  assert.equal(removeLegacyHooks(file), true)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(after, { hooks: { PreToolUse: [{ matcher: 'x', hooks: [aiterm] }] }, keep: true })
  assert.equal(removeLegacyHooks(file), false)
})
