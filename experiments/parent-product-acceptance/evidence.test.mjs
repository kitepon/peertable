import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseDelivered, judgeAudience, buildCase, buildRecord, selfAudit, acceptCase, cleanupFailure } from './evidence.mjs'
import { readJsonl, readTranscript, startupAction, ownTrustKeys } from './harness.mjs'
import { openAiterm } from './aiterm.mjs'
import { renderDelivery } from '../../skill/scripts/parent-delivery.mjs'

const scratch = t => { const dir = mkdtempSync(join(tmpdir(), 'ptacc-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }

const state = { room: 'r1', name: 'bell' }
const body = '日本語\n「引用」😀\n[配送ID=偽] 符号 N1'
const record = { delivery_id: '11111111-2222-3333-4444-555555555555', digest: 'a'.repeat(64), state: 'submitted', event: { seq: 7, from: 'probe', to: 'bell', body }, receipt: { reason: 'x' } }
const rendered = renderDelivery(state, record)

test('製品の描画から本文・宛先・seqを欠けなく読み戻す', () => {
  const [parsed] = parseDelivered(`前置き\n${rendered}\n後置き`)
  assert.deepEqual({ room: parsed.room, from: parsed.from, to: parsed.to, seq: parsed.seq, body: parsed.body, delivery_id: parsed.delivery_id }, { room: 'r1', from: 'probe', to: 'bell', seq: 7, body, delivery_id: record.delivery_id })
})

const posted = { room: 'r1', from: 'probe', to: 'bell', seq: 7, body, nonce: 'N1' }
const base = { label: 'dm', posted, record, receipt: { state: 'delivered', receipt_revision: 2 }, session: 's1', recipient: 'bell' }
const delivered = parseDelivered(rendered).map(item => ({ ...item, order: 3, session: 's1', turn_id: 't1' }))
const replies = [{ order: 4, session: 's1', turn_id: 't1', text: '符号 N1' }]

test('実境界で1回・原文一致・後続返答・receiptが揃った時だけpassed', () => {
  assert.equal(judgeAudience({ ...base, deliveries: delivered, replies }).status, 'passed')
  assert.deepEqual(judgeAudience({ ...base, deliveries: [...delivered, ...delivered], replies }).reasons, ['HARNESS_DELIVERY_COUNT_2'])
  assert.ok(judgeAudience({ ...base, deliveries: [], replies }).reasons.includes('HARNESS_DELIVERY_COUNT_0'))
  assert.ok(judgeAudience({ ...base, deliveries: delivered, replies: [{ ...replies[0], order: 1 }] }).reasons.includes('ASSISTANT_REPLY_MISSING'))
  assert.ok(judgeAudience({ ...base, deliveries: delivered.map(item => ({ ...item, body: item.body + 'x' })), replies }).reasons.includes('HARNESS_BODY_MISMATCH'))
  assert.ok(judgeAudience({ ...base, receipt: { state: 'unknown', receipt_revision: 3 }, deliveries: delivered, replies }).reasons.includes('ROOM_RECEIPT_unknown'))
})

const meta = { os: 'darwin', harness: 'claude', surface: 'cli', source_commit: 'b'.repeat(40), runtime_digest: 'c'.repeat(64), package_version: '0.8.63', harness_version: '2.1.283', parent_session: 's1' }
test('証拠はgateの形式を満たし、失敗checkはfailedのまま目録へ出る', () => {
  const check = judgeAudience({ ...base, deliveries: delivered, replies })
  const observations = [{ kind: 'delivery_in_parent_conversation', parent_session: 's1', turn_id: 't1' }]
  const evidence = buildCase({ meta, scenario: 'audience', checks: [check], observations })
  const record = buildRecord(evidence, 'x.json', { audiences: { dm: { count: 1, body_equal: true }, multiple: { count: 1, body_equal: true }, all: { count: 1, body_equal: true } } })
  assert.deepEqual(selfAudit(record, evidence).gate_errors, [])
  const bad = buildCase({ meta, scenario: 'audience', checks: [judgeAudience({ ...base, deliveries: [], replies })], observations })
  assert.equal(buildRecord(bad, 'x.json').status, 'failed')
  assert.ok(selfAudit(buildRecord(bad, 'x.json'), bad).gate_errors.some(error => error.code === 'PARENT_ACCEPTANCE_INVALID'))
  assert.throws(() => buildCase({ meta, scenario: 'audience', checks: [], observations }), { code: 'ACCEPTANCE_NO_OBSERVATION' })
})

test('Codexのhook_prompt要素はXML文字参照だけを復号し、生textとの差を残す', async t => {
  const { readTranscript, decodeXmlText } = await import('./harness.mjs')
  const special = 'x < y & "z" \'q\' 字面&gt;\n二行目', shown = renderDelivery(state, { ...record, event: { ...record.event, body: special } })
  const escaped = shown.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const dir = scratch(t), file = join(dir, 'rollout.jsonl')
  const row = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  writeFileSync(file, [JSON.stringify({ type: 'turn_context', payload: { turn_id: 't9' } }), row(`<hook_prompt hook_run_id="stop:1:/h.json">${escaped}</hook_prompt>`), row(shown)].join('\n') + '\n')
  const seen = readTranscript('codex', file)
  assert.deepEqual(seen.injections.map(item => [item.hook, item.encoding, item.turn_id]), [['stop', 'codex_hook_prompt_xml_text', 't9'], [null, 'none', 't9']])
  assert.equal(parseDelivered(seen.injections[0].text)[0].body, special)
  assert.notEqual(parseDelivered(seen.injections[0].raw_text)[0].body, special)
  assert.equal(parseDelivered(seen.injections[1].text)[0].body, special)
  assert.equal(decodeXmlText('&amp;gt; &unknown; &#x1F600;'), '&gt; &unknown; 😀')
})

test('確定行の不正JSONは止め、改行の無い末尾は未確定として読まない', t => {
  const good = JSON.stringify({ type: 'x' })
  assert.deepEqual(readJsonl(`${good}\n${good.slice(0, 5)}`, 'f'), { rows: [{ order: 0, row: { type: 'x' } }], pending_tail: 5 })
  assert.equal(readJsonl(`${good}\n`, 'f').pending_tail, 0)
  assert.throws(() => readJsonl(`${good}\n{broken\n${good}\n`, 'f'), { code: 'ACCEPTANCE_TRANSCRIPT_CORRUPT', line: 2 })
  const file = join(scratch(t), 'session.jsonl')
  writeFileSync(file, `${good}\n{"type":"user","mess`)
  assert.equal(readTranscript('claude', file).pending_tail, 20)
})

test('後片付けの未完了は成功へ丸めず原因codeを返す', () => {
  assert.equal(cleanupFailure('harness_exit', { exited: true }), null)
  assert.equal(cleanupFailure('harness_exit', { exited: false }).code, 'ACCEPTANCE_HARNESS_NOT_EXITED')
  const stopped = { owned_alive_after: [], runtime_after: 'stopped', product_stopped_within_30s: true, stopped_by_runner: false, product_index_left_after_stop: false }
  assert.equal(cleanupFailure('endpoint_stop', stopped), null)
  assert.equal(cleanupFailure('endpoint_stop', { ...stopped, owned_alive_after: [42] }).code, 'ACCEPTANCE_OWNED_PROCESS_ALIVE')
  assert.equal(cleanupFailure('endpoint_stop', { ...stopped, runtime_after: 'armed' }).code, 'ACCEPTANCE_ENDPOINT_NOT_STOPPED')
  // runnerが止めた・索引を外した場合も、製品の終了処理が未完了ならrun成功にしない。
  assert.deepEqual(cleanupFailure('endpoint_stop', { ...stopped, product_stopped_within_30s: false, stopped_by_runner: true }).codes, ['PRODUCT_ENDPOINT_NOT_SELF_STOPPED', 'PRODUCT_ENDPOINT_STOPPED_BY_RUNNER'])
  assert.deepEqual(cleanupFailure('endpoint_stop', { ...stopped, product_index_left_after_stop: true }).codes, ['PRODUCT_STOPPED_ENDPOINT_INDEX_LEFT'])
  assert.equal(cleanupFailure('endpoint_stop', { owned_alive_after: [], runtime_after: 'stopped' }).code, 'PRODUCT_ENDPOINT_NOT_SELF_STOPPED')
  assert.equal(cleanupFailure('pty_close', { outcome: 'closed', pane_alive_after: null }).code, 'ACCEPTANCE_PANE_ALIVE')
  assert.equal(cleanupFailure('room_server', { alive_after: true }).code, 'ACCEPTANCE_ROOM_ALIVE')
  assert.equal(cleanupFailure('scenario_proxy', { closed: true }), null)
  assert.equal(cleanupFailure('scenario_proxy', { closed: false }).code, 'ACCEPTANCE_PROXY_NOT_CLOSED')
  assert.equal(cleanupFailure('codex_folder_trust_remove', { remaining_trust_entries: 1 }).code, 'ACCEPTANCE_TRUST_ENTRY_LEFT')
  assert.equal(cleanupFailure('connect_remove', { removed: ['codex:removed'], semantic_equal: true, config_text_equal: true }), null)
  assert.equal(cleanupFailure('connect_remove', { removed: ['codex:removed'], semantic_equal: true, config_text_equal: false }).code, 'ACCEPTANCE_CONFIG_TEXT_CHANGED')
  assert.equal(cleanupFailure('connect_remove', { removed: ['claude:failed'], semantic_equal: true }).code, 'ACCEPTANCE_CONNECT_REMOVE_FAILED')
  assert.throws(() => cleanupFailure('unknown_step', {}), { code: 'ACCEPTANCE_CLEANUP_UNKNOWN' })
})

test('gateが拒否したpassedは目録へ出さず、failedはrun成功に数えない', () => {
  const record = { id: 'darwin/claude/cli/audience', status: 'passed' }
  assert.throws(() => acceptCase(record, { gate_errors: [{ code: 'PARENT_ACCEPTANCE_EVIDENCE_INVALID' }] }), { code: 'ACCEPTANCE_SELF_AUDIT_FAILED' })
  assert.deepEqual(acceptCase(record, { gate_errors: [] }), { run_ok: true })
  assert.deepEqual(acceptCase({ ...record, status: 'failed' }, { gate_errors: [{ code: 'PARENT_ACCEPTANCE_INVALID' }] }), { run_ok: false })
})

// 実aitermの代わりに、MCP stdio境界で既知の応答を返す小さなserverを使う。人間向けtextは解釈しないことを確かめる。
test('Aitermはstructured結果だけを使い、欠落はtyped errorにする', async t => {
  const dir = scratch(t), server = join(dir, 'fake-aiterm.mjs')
  writeFileSync(server, `import { createInterface } from 'node:readline'
const mode = process.env.FAKE_MODE
const send = row => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...row }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line)
  if (row.id === undefined) return
  if (row.method === 'initialize') return send({ id: row.id, result: {} })
  const { name, arguments: args } = row.params
  if (name === 'pty_open') return send({ id: row.id, result: { content: [{ type: 'text', text: 'session_id: ' + args.name }] } })
  if (name === 'pty_observe') return send({ id: row.id, result: { content: [{ type: 'text', text: '{}' }], ...(mode === 'text_only' ? {} : { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: args.session_id, exists: mode !== 'missing' } }) } })
  if (name === 'pty_close') return send({ id: row.id, result: { content: [{ type: 'text', text: 'closed' }], structuredContent: { schema: 'aiterm.pty-close-result.v1', session_id: args.session_id, outcome: 'closed' } } })
})`)
  const run = async mode => {
    process.env.FAKE_MODE = mode
    const aiterm = await openAiterm({ executable: process.execPath, args: [server] })
    try { return await aiterm.open('s1') } finally { await aiterm.end() }
  }
  t.after(() => { delete process.env.FAKE_MODE })
  assert.equal(await run('ok'), 's1')
  await assert.rejects(run('text_only'), { code: 'ACCEPTANCE_AITERM_STRUCTURED_MISSING' })
  await assert.rejects(run('missing'), { code: 'ACCEPTANCE_AITERM_SESSION_ID_MISSING' })
  process.env.FAKE_MODE = 'ok'
  const aiterm = await openAiterm({ executable: process.execPath, args: [server] })
  assert.deepEqual(await aiterm.close('s1'), { schema: 'aiterm.pty-close-result.v1', session_id: 's1', outcome: 'closed' })
  await aiterm.end()
  assert.ok(existsSync(dir))
})

// 実機で観測した起動画面の抜粋。未知のdialogは押さずにnullを返す。
test('起動dialogは観測済みの文言だけに操作を返す', () => {
  const claudeTrust = ' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n'
  const chrome = '  Claude in Chrome extension detected\n  ❯ No, keep browser tools off\n    Yes, use my browser\n  Enter to confirm · Esc to keep browser tools off\n'
  const codex155 = '  Do you trust the contents of this directory? Working with untrusted contents\n› 1. Yes, continue\n  2. No, quit\n  Press enter to continue\n'
  const codex158 = '  Trust this folder? Codex can read, edit, and run files here, subject to your\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit\n'
  assert.deepEqual(startupAction('claude', claudeTrust), { keys: ['Down', 'Enter'], reason: 'claude_folder_trust' })
  assert.deepEqual(startupAction('claude', chrome), { keys: ['Enter'], reason: 'claude_chrome_notice_keep_off' })
  assert.equal(startupAction('claude', chrome.replace('❯ No, keep', '  No, keep').replace('    Yes, use', '❯ Yes, use')), null)
  assert.deepEqual(startupAction('codex', codex155), { keys: ['Enter'], reason: 'codex_directory_trust' })
  assert.deepEqual(startupAction('codex', codex158), { keys: ['Enter'], reason: 'codex_directory_trust' })
  assert.equal(startupAction('codex', codex158.replace('› 1. Trust', '  1. Trust').replace('  2. Quit', '› 2. Quit')), null)
  assert.deepEqual(startupAction('codex', '  ✨ Update available! 0.155.1 -> 0.158.0\n'), { blocked: 'codex_update_prompt' })
  assert.equal(startupAction('codex', '  Some new dialog\n› 1. Accept\n'), null)
})

test('Codexの信頼entryはWindowsの大小文字差を吸収し同prefixの隣projectを残す', () => {
  const out = 'C:\\Users\\kite_\\ptacc\\run'
  const projects = { 'c:\\users\\kite_\\ptacc\\run\\project-1': {}, 'C:\\Users\\kite_\\ptacc\\run-other\\user': {}, 'c:\\users\\kite_\\ptacc\\run\\old': {} }
  assert.deepEqual(ownTrustKeys(projects, { 'C:\\Users\\kite_\\ptacc\\run\\old': {} }, out, 'win32'), ['c:\\users\\kite_\\ptacc\\run\\project-1'])
  assert.deepEqual(ownTrustKeys({ '/tmp/Run/p': {}, '/tmp/run/p': {}, '/tmp/run-other/p': {} }, {}, '/tmp/run', 'linux'), ['/tmp/run/p'])
})
