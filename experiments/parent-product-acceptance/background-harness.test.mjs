import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readBackgroundJsonl, parseCursorNativeTranscript, parseGrokNativeUpdates, createBackgroundHarnessObserver } from './background-harness.mjs'

// このfake-native fixtureはparser境界だけを検証する。製品の実機成績には使わない。
const cid = 'native-conversation', deliveryId = '11111111-1111-1111-1111-111111111111', digest = 'a'.repeat(64)
const jl = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
const rendered = body => `[Peertable room=room from=worker to=all seq=4]\n本文: ${body}\n[配送ID=${deliveryId} digest=${digest}]`
const background = body => ({ schema: 'peertable.parent-background-result.v1', delivery_id: deliveryId, digest, ...(body !== undefined ? { text: rendered(body) } : {}) })
const cursorFile = body => Buffer.from(`---\npid: 42\ncommand: node /package/skill/scripts/parent-receive.mjs\nstatus: succeeded\n---\n${JSON.stringify(background(body))}\n\n---\nexit_code: 0\n---\n`)
const cursorFixture = ({ body = '日本語\n  原文\t ', repeat = false, duplicate = false, pendingRead = false } = {}) => {
  const paths = ['/native/terminals/42.txt', '/native/terminals/43.txt'], files = new Map(paths.map(path => [path, cursorFile(body)])), hooks = [], rows = []
  const addRead = (path, length, turn) => {
    rows.push({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path } }] } })
    hooks.push({ event: { hook_event_name: 'postToolUse', conversation_id: cid, generation_id: turn, tool_use_id: `read-${rows.length}`, tool_name: 'Read', tool_input: { file_path: path }, tool_output: JSON.stringify({ file_path: path, content_length: length }) } })
  }
  if (pendingRead) addRead(paths[0], 20, 'before-completion')
  addRead(paths[0], files.get(paths[0]).toString('utf8').length, 'actual-turn')
  if (repeat) addRead(paths[0], files.get(paths[0]).toString('utf8').length, 'repeat-turn')
  if (duplicate) addRead(paths[1], files.get(paths[1]).toString('utf8').length, 'duplicate-turn')
  rows.push({ role: 'assistant', message: { content: [{ type: 'text', text: `受信: ${body}` }] } })
  return { transcript: jl(rows), hooks, expectedConversationId: cid, readTaskFile: path => files.get(path) }
}
const page = (body, offset, total, complete) => ({ schema: 'peertable.parent-read-page.v1', endpoint_id: 'endpoint', delivery_id: deliveryId, digest, event: { room: 'room', from: 'worker', to: 'all', seq: 4, body }, offset, total_characters: total, complete })
const grokFixture = (pages, { duplicate = false, noReader = false } = {}) => {
  const updates = [], add = update => updates.push({ params: { sessionId: cid, update } })
  add({ sessionUpdate: 'task_completed', task_snapshot: { task_id: 'task-1', owner_session_id: cid, completed: true } })
  if (!noReader) {
    add({ sessionUpdate: 'tool_call', toolCallId: 'reader', title: 'get_command_or_subagent_output', rawInput: { task_ids: ['task-1'] } })
    add({ sessionUpdate: 'tool_call_update', toolCallId: 'reader', rawOutput: { type: 'TaskOutput', Result: { task_id: 'task-1', truncated: false, status: 'completed', output: JSON.stringify(background()) + '\n' } } })
  }
  for (const [i, value] of (duplicate ? [...pages, ...pages] : pages).entries()) {
    add({ sessionUpdate: 'tool_call', toolCallId: `page-${i}`, title: 'use_tool', rawInput: { tool_name: 'peertable_parent__parent_read', tool_input: { delivery_id: deliveryId } } })
    add({ sessionUpdate: 'tool_call_update', toolCallId: `page-${i}`, rawOutput: { type: 'MCP', tool_name: 'parent_read', output: { OkayOutput: JSON.stringify({ schema: 'peertable.parent-read-result.v1', page: value }) } } })
  }
  add({ sessionUpdate: 'agent_message_chunk', content: { text: '受信: ' } })
  add({ sessionUpdate: 'hook_execution' })
  add({ sessionUpdate: 'agent_message_chunk', content: { text: '日本語\n  原文\t ' } })
  add({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-task-1' })
  return { transcript: jl(updates), expectedConversationId: cid }
}

test('確定JSONL破損はtyped error、追記中末尾はpending_tail', () => {
  const source = Buffer.from('{"value":"原文"}\n{"incomplete":')
  const seen = readBackgroundJsonl(source)
  assert.equal(seen.rows.length, 1); assert.equal(seen.pending_tail, 14)
  assert.throws(() => readBackgroundJsonl(Buffer.from('{}\n壊れた行\n')), { code: 'ACCEPTANCE_TRANSCRIPT_CORRUPT' })
})

test('先頭BOMはJSON decodeだけで処理し原bytesと本文を保持', () => {
  const fixture = cursorFixture(), original = fixture.transcript
  fixture.transcript = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])
  const before = Buffer.from(fixture.transcript), seen = parseCursorNativeTranscript(fixture)
  assert.deepEqual(fixture.transcript, before)
  assert.equal(seen.deliveries[0].body, '日本語\n  原文\t ')
})

test('Cursor完了前Readを除き、同taskの再Readは配送を重複算入しない', () => {
  const seen = parseCursorNativeTranscript(cursorFixture({ pendingRead: true, repeat: true }))
  assert.equal(seen.deliveries.length, 1)
  assert.equal(seen.deliveries[0].turn_id, 'actual-turn')
  assert.equal(seen.deliveries[0].order, 1)
  assert.equal(seen.toolUses.length, 3)
})

test('別native taskに同配送が出た真の重複は残す', () => {
  const seen = parseCursorNativeTranscript(cursorFixture({ duplicate: true }))
  assert.equal(seen.deliveries.length, 2)
  assert.deepEqual(seen.deliveries.map(item => item.native_task_id), ['42', '43'])
})

test('Cursor hookとGrok session/taskに別CIDが入ればtyped error', () => {
  const cursor = cursorFixture(); cursor.hooks[0].event.conversation_id = 'other'
  assert.throws(() => parseCursorNativeTranscript(cursor), { code: 'ACCEPTANCE_NATIVE_SESSION_MISMATCH' })
  const grok = grokFixture([page('a', 0, 1, true)]), rows = readBackgroundJsonl(grok.transcript).rows.map(item => item.row)
  rows[0].params.update.task_snapshot.owner_session_id = 'other'
  assert.throws(() => parseGrokNativeUpdates({ ...grok, transcript: jl(rows) }), { code: 'ACCEPTANCE_NATIVE_SESSION_MISMATCH' })
})

test('Grok長文pageを無加工で束ね公式task-completed turnと返答chunkを保持', () => {
  const first = '日本語\n', last = '  原文\t ', pages = [page(first, 0, first.length + last.length, false), page(last, first.length, first.length + last.length, true)]
  const seen = parseGrokNativeUpdates(grokFixture(pages))
  assert.deepEqual(seen.pages.map(item => item.page), pages)
  assert.equal(seen.deliveries.length, 1)
  assert.equal(seen.deliveries[0].body, first + last)
  assert.equal(seen.deliveries[0].turn_id, 'task-completed-task-1')
  assert.equal(seen.replies[0].text, '受信: 日本語\n  原文\t ')
  assert.ok(seen.pages.every(item => item.completed_order < item.reader_order && item.reader_order < item.order))
})

test('Grok全文readerなしを受信にしない、complete後の二重page回収は残す', () => {
  const pages = [page('a', 0, 1, true)]
  assert.throws(() => parseGrokNativeUpdates(grokFixture(pages, { noReader: true })), { code: 'ACCEPTANCE_NATIVE_FULL_READER_MISSING' })
  assert.equal(parseGrokNativeUpdates(grokFixture(pages, { duplicate: true })).deliveries.length, 2)
})

test('Cursor previewと公式長文page回収は一配送として関連付ける', () => {
  const fixture = cursorFixture({ body: '前半' }), rows = readBackgroundJsonl(fixture.transcript).rows.map(item => item.row), body = '前半\n 後半 '
  // native背景previewの正式な末尾だけをfixture生成時に指定する。
  const nativePath = '/native/terminals/42.txt', bytes = Buffer.from(cursorFile('前半').toString().replace(`digest=${digest}]`, `digest=${digest} 全文取得=parent_read]`))
  fixture.readTaskFile = () => bytes
  fixture.hooks[0].event.tool_output = JSON.stringify({ file_path: nativePath, content_length: bytes.toString().length })
  const pages = [page(body.slice(0, 3), 0, body.length, false), page(body.slice(3), 3, body.length, true)]
  for (const [i, value] of pages.entries()) {
    const args = { delivery_id: deliveryId, endpoint_id: 'endpoint', ...(i ? { continuation_key: 'opaque' } : {}) }
    rows.push({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallDynamicTool', input: { namespace: 'peertable_parent', toolName: 'parent_read', arguments: args } }] } })
    fixture.hooks.push({ input: { conversation_id: cid, generation_id: 'actual-turn', hook_event_name: 'postToolUse', tool_name: 'MCP:parent_read', tool_input: args, tool_use_id: `parent-${i}`, tool_output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ schema: 'peertable.parent-read-result.v1', page: value }) }], structuredContent: { schema: 'peertable.parent-read-result.v1', page: value } }) } })
  }
  const seen = parseCursorNativeTranscript({ ...fixture, transcript: jl(rows) })
  assert.equal(seen.deliveries.length, 1); assert.equal(seen.deliveries[0].preview, true)
  assert.deepEqual(seen.pages.map(item => item.page), pages)
})

// 外部保存データの再観測はparserの受入で、過去の製品成績の新規作成ではない。
test('保存済み6cellの原文18件・実turn・後続返答を既存公開証拠と照合', { skip: !process.env.BACKGROUND_NATIVE_EVIDENCE_DIR }, () => {
  const root = process.env.BACKGROUND_NATIVE_EVIDENCE_DIR
  let count = 0
  for (const cell of readdirSync(join(root, 'raw'))) {
    const dir = join(root, 'raw', cell), harness = cell.endsWith('cursor') ? 'cursor' : 'grok'
    const state = JSON.parse(readFileSync(join(dir, 'final-state.json'))), session = state.spools[0].caller.conversation
    const os = cell.includes('-mac-') ? 'darwin' : cell.includes('-win-') ? 'win32' : 'linux'
    const evidence = JSON.parse(readFileSync(join(root, 'public/rag/parent-delivery/live', os, harness, 'cli/audience.json')))
    const observer = createBackgroundHarnessObserver({ harness, expectedConversationId: session, hookPaths: [join(dir, 'hook-events.jsonl')], transcriptPath: harness === 'cursor' ? join(dir, 'agent-transcripts', session, `${session}.jsonl`) : join(dir, 'grok-updates.jsonl'), readTaskFile: path => readFileSync(join(dir, 'terminals', path.split(/[\\/]/u).at(-1))) })
    const seen = observer.observe()
    for (const check of evidence.checks) {
      const matches = seen.deliveries.filter(item => item.delivery_id === check.delivery.delivery_id)
      assert.equal(matches.length, 1, `${cell}:${check.label}`)
      const received = matches[0]
      assert.deepEqual({ room: received.room, from: received.from, to: received.to, seq: received.seq, body: received.body }, check.received)
      assert.equal(received.turn_id, check.delivery.turn_id)
      assert.equal(received.order, check.delivery.order)
      assert.ok(seen.replies.some(reply => reply.session === session && reply.order > received.order && reply.turn_id === check.reply.turn_id && reply.text === check.reply.text))
      count++
    }
  }
  assert.equal(count, 18)
})
