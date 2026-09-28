// fixture終了と設定読取りのfocused test。product_liveの証拠には用いない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertOnlyProjectTrustChanged, hookConfigurationSnapshot, waitOwnedFixtureExit } from './scenarios-fixtures.mjs'

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
