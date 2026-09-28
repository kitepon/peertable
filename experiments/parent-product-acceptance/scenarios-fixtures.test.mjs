// fixture終了と設定読取りのfocused test。product_liveの証拠には用いない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { processIdentity, sameProcess } from '../../skill/scripts/parent-platform.mjs'
import { assertOnlyProjectTrustChanged, hookConfigurationSnapshot, waitOwnedFixtureExit, nativeHookObserverSource, appendGrokProductObserver, observeFixtureProcessIdentity, fixtureJoinInstruction, setClaudeSessionHookFault, claudeResumeReady } from './scenarios-fixtures.mjs'

test('fixture終了は実child消失の後も製品自己停止と索引撤去を待つ', async t => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),150)'], { stdio: 'ignore' })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let runtime = 'armed', indexed = true
  const stopped = setTimeout(() => { runtime = 'stopped' }, 300), removed = setTimeout(() => { indexed = false }, 450)
  t.after(() => { clearTimeout(stopped); clearTimeout(removed) })
  const started = Date.now()
  const proof = await waitOwnedFixtureExit({ readEndpoints: () => [{ id: 'own', read: () => ({ runtime, watcher: { pid: child.pid } }) }], sameProcess: owner => owner.pid === child.pid && child.exitCode === null, knownOwners: [{ pid: child.pid }], indexExists: () => indexed, timeout: 2000 })
  assert.ok(Date.now() - started >= 400)
  assert.equal(proof.known_processes_gone, true); assert.equal(proof.indexes_gone, true)
})

test('join前の失敗でも既知pane/native childが消えるまでcleanup成功にしない', async t => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),250)'], { stdio: 'ignore' })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const started = Date.now()
  await waitOwnedFixtureExit({ readEndpoints: () => [], sameProcess: owner => owner.pid === child.pid && child.exitCode === null, knownOwners: [{ pid: child.pid }], indexExists: () => false, timeout: 2000 })
  assert.ok(Date.now() - started >= 200); assert.equal(child.exitCode, 0)
  await assert.rejects(waitOwnedFixtureExit({ readEndpoints: () => [], sameProcess: () => true, knownOwners: [{ pid: 123 }], indexExists: () => false, timeout: 1 }), { code: 'ACCEPTANCE_FIXTURE_TIMEOUT' })
})

test('BOM付き通常hook設定を読み、元bytesを変更せず照合する', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-scenarios-bom-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'hooks.json'), bytes = Buffer.from('\uFEFF{\r\n  "version": 1, "hooks": {}\r\n}\r\n')
  writeFileSync(file, bytes)
  const snapshot = hookConfigurationSnapshot(file)
  assert.equal(snapshot.beforeHooks.version, 1); snapshot.assertHooksUnchanged(); assert.deepEqual(readFileSync(file), bytes)
  writeFileSync(file, bytes.toString('utf8').slice(1))
  assert.throws(() => snapshot.assertHooksUnchanged(), { code: 'ACCEPTANCE_USER_HOOK_CONFIG_CHANGED' })
})


test('専用project trustの1 entryだけを許し、他設定の意味差と既存entry上書きを拒否する', () => {
  const project = '/専用 fixture/new', before = { model: 'gpt-6-sol', projects: { '/既存': { trust_level: 'trusted' } }, hooks: { state: { foreign: { enabled: false } } } }
  const after = structuredClone(before); after.projects[project] = { trust_level: 'trusted' }
  assertOnlyProjectTrustChanged(before, after, project)
  assertOnlyProjectTrustChanged(after, before, project, { remove: true })
  const changed = structuredClone(after); changed.hooks.state.foreign.enabled = true
  assert.throws(() => assertOnlyProjectTrustChanged(before, changed, project), { code: 'ACCEPTANCE_PROJECT_TRUST_OTHER_SETTINGS_CHANGED' })
  assert.throws(() => assertOnlyProjectTrustChanged(after, after, project), { code: 'ACCEPTANCE_PROJECT_TRUST_ALREADY_PRESENT' })
  assert.throws(() => assertOnlyProjectTrustChanged(before, before, project, { remove: true }), { code: 'ACCEPTANCE_PROJECT_TRUST_BASELINE_MISSING' })
  assertOnlyProjectTrustChanged({}, { projects: { [project]: { trust_level: 'trusted' } } }, project)
  assertOnlyProjectTrustChanged({ projects: { [project]: { trust_level: 'trusted' } } }, {}, project, { remove: true })
})


test('公式hook observerは起動時PID/startを保存し、解除後の本人消失を照合する', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'peertable-observer-identity-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, 'observer.mjs'), observed = join(directory, 'events.jsonl'), controls = join(directory, 'controls.json'), release = join(directory, 'release.json')
  writeFileSync(script, nativeHookObserverSource(pathToFileURL(join(process.cwd(), 'skill/scripts/parent-platform.mjs')).href))
  writeFileSync(controls, JSON.stringify({ hold: true, release }))
  const child = spawn(process.execPath, [script, observed, controls], { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const ended = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  const event = { hook_event_name: 'stop', status: 'completed', conversation_id: 'own', generation_id: 'turn', text: '字面 & 日本語' }
  child.stdin.end(JSON.stringify(event))
  let row = null
  const deadline = Date.now() + 3000
  while (!row) { try { row = JSON.parse(readFileSync(observed, 'utf8').trim()) } catch (error) { if (error.code !== 'ENOENT') throw error }; assert.ok(Date.now() < deadline); if (!row) await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.deepEqual(row.event, event); assert.equal(row.pid, child.pid); assert.equal(row.owner.pid, child.pid); assert.equal(row.owner.started, processIdentity(child.pid).started)
  assert.equal(sameProcess(row.owner), true); assert.equal(sameProcess({ ...row.owner, started: '同PIDの別起動' }), false)
  writeFileSync(release, '{}'); assert.equal(await ended, 0); assert.equal(sameProcess(row.owner), false)
})


test('専用Grokの直列prehookは製品handler直後へ追加し、他eventの原形を保つ', t => {
  const directory = mkdtempSync(join(tmpdir(), 'peertable-grok-hook-order-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'peertable-parent.json'), product = { type: 'command', command: 'own product prehook' }, observer = { type: 'command', command: 'own observer', timeout: 86400 }, other = [{ hooks: [{ type: 'command', command: 'own product posthook' }] }]
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__peertable_parent__parent_join', hooks: [product] }], PostToolUse: other } }))
  const value = appendGrokProductObserver(JSON.parse(readFileSync(file, 'utf8')), 'PreToolUse', observer); writeFileSync(file, JSON.stringify(value))
  const actual = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(actual.hooks.PreToolUse[0].hooks, [product, observer]); assert.deepEqual(actual.hooks.PostToolUse, other)
  assert.throws(() => appendGrokProductObserver(actual, 'PreToolUse', observer), { code: 'ACCEPTANCE_PROJECT_PREHOOK_ORDER_UNCONFIRMED' })
})

test('束縛observerは同eventのparent_joinだけを実processでholdする', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'peertable-binding-observer-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, 'observer.mjs'), observed = join(directory, 'events.jsonl'), controls = join(directory, 'controls.json'), release = join(directory, 'release.json')
  writeFileSync(script, nativeHookObserverSource(pathToFileURL(join(process.cwd(), 'skill/scripts/parent-platform.mjs')).href))
  writeFileSync(controls, JSON.stringify({ hold: true, onlyTool: 'parent_join', onlyEvent: 'PreToolUse', release }))
  async function invoke(event) {
    const child = spawn(process.execPath, [script, observed, controls], { stdio: ['pipe', 'pipe', 'inherit'] })
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') }); const ended = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }); child.stdin.end(JSON.stringify(event)); return { child, ended }
  }
  for (const event of [{ hook_event_name: 'PreToolUse', tool_name: 'mcp__peertable_parent__parent_read' }, { hook_event_name: 'PostToolUse', tool_name: 'mcp__peertable_parent__parent_join' }]) {
    const call = await invoke(event); assert.equal(await call.ended, 0)
  }
  const call = await invoke({ hook_event_name: 'PreToolUse', toolName: 'mcp__peertable_parent__parent_join' })
  let entries = []; const deadline = Date.now() + 3000
  while (entries.length < 3) { try { entries = readFileSync(observed, 'utf8').trim().split('\n').map(JSON.parse) } catch (error) { if (error.code !== 'ENOENT') throw error }; assert.ok(Date.now() < deadline); if (entries.length < 3) await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.deepEqual(entries.map(row => row.held), [false, false, true]); assert.equal(call.child.exitCode, null); assert.equal(entries[2].control_release, release); assert.equal(sameProcess(entries[2].owner), true)
  writeFileSync(release, '{}'); assert.equal(await call.ended, 0); assert.equal(sameProcess(entries[2].owner), false)
})


test('process API失敗は実OS原応答を私物artifactへ保存し、元errorとstackを伝播する', t => {
  const directory = mkdtempSync(join(tmpdir(), 'peertable-process-diagnostic-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const error = Object.assign(new Error('実schema境界の再現'), { code: 'PARENT_PROCESS_API_SCHEMA_INVALID' })
  assert.throws(() => observeFixtureProcessIdentity({ processIdentity: () => { throw error } }, process.pid, directory), caught => caught === error)
  const raw = JSON.parse(readFileSync(error.detail.artifact, 'utf8')); assert.equal(raw.pid, process.pid); assert.equal(raw.error.code, error.code); assert.equal(raw.error.stack, error.stack)
  if (process.platform === 'darwin') { assert.equal(raw.responses[0].code, 0); assert.match(raw.responses[0].stdout, /node/u); assert.equal(raw.responses[1].code, 0); assert.match(raw.responses[1].stdout, /n\//u) }
  assert.deepEqual(observeFixtureProcessIdentity({ processIdentity }, process.pid, directory), processIdentity(process.pid))
})

test('Grok初期joinは実task完了後のtask_idsだけの全文readerを指示する', () => {
  const grok = fixtureJoinInstruction({ harness: 'grok', project: '/私物 project', name: '親' })
  assert.match(grok, /公式task_completed.*同じtask_id/u); assert.match(grok, /入力はtask_idsの1キーだけ/u); assert.match(grok, /timeout_msキーは付けず、0も不可/u); assert.match(grok, /公式全文readerの結果にdelivery_idがある場合だけ/u)
  const cursor = fixtureJoinInstruction({ harness: 'cursor', project: '/私物', name: '親' }); assert.match(cursor, /公式Readで全文/u); assert.match(cursor, /offset\/limitを付けず/u); assert.doesNotMatch(cursor, /get_command_or_subagent_output/u)
  assert.doesNotMatch(fixtureJoinInstruction({ harness: 'claude', project: '/私物', name: '親' }), /task_ids|Shell/u)
})


test('Claude hook障害は同CIDの自己CLI設定だけを変え、元session設定とglobal bytesを保持する', async () => {
  const actions = [], original = { model: '設定の原値', permissions: { allow: ['Read'] } }
  const fixture = { harness: 'claude', session: '自己会話', sessionSettings: original, configuration: { hooks: '/通常/settings.json', assertHooksUnchanged: () => actions.push('通常bytes照合') }, stopOwnPane: async () => actions.push('自己CLI終了'), launch: async options => actions.push({ options, settings: structuredClone(fixture.sessionSettings) }) }
  const disabled = await setClaudeSessionHookFault(fixture, true)
  assert.equal(disabled.global_changed, false); assert.equal(disabled.official_option, '--settings')
  assert.deepEqual(actions[2], { options: { resume: '自己会話' }, settings: { ...original, disableAllHooks: true } })
  assert.equal(Object.hasOwn(original, 'disableAllHooks'), false)
  await setClaudeSessionHookFault(fixture, false)
  assert.equal(fixture.sessionSettings, original); assert.equal(fixture.claudeHookFault, null)
  assert.deepEqual(actions[6], { options: { resume: '自己会話' }, settings: original })
  await assert.rejects(setClaudeSessionHookFault({ ...fixture, harness: 'cursor' }, true), { code: 'ACCEPTANCE_CLAUDE_SESSION_FAULT_UNBOUND' })
})


test('Claudeのヘッダ無しresumeは実CID argv・存命CLI本人・公式空promptを照合する', () => {
  const session = 'ac5f033b-462c-49c6-971b-d38a13ed5ad8', screen = ' ▝▜██████▀  Sonnet 5.5 · Claude Pro\n❯ \n', owner = { pid: 10, started: '専用開始', executable: process.execPath, command: `${process.execPath} --resume ${session} --settings /専用設定` }
  const input = { screen, session, executable: process.execPath, owners: [owner], sameProcess: () => true }
  assert.equal(claudeResumeReady(input), true)
  assert.equal(claudeResumeReady({ ...input, screen: '過去の自己会話\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents' }), true)
  assert.equal(claudeResumeReady({ ...input, sameProcess: () => false }), false)
  assert.equal(claudeResumeReady({ ...input, session: '00000000-0000-0000-0000-000000000000' }), false)
  assert.equal(claudeResumeReady({ ...input, screen: screen.replace('❯ ', '❯ 作業中') }), false)
  assert.equal(claudeResumeReady({ ...input, screen: screen.replace('Claude Pro', '別製品') }), false)
})
