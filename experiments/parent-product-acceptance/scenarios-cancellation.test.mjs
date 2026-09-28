// 実owned dummyと待機timerの回収だけを検証する。製品lease/正式成績を作らない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { processIdentity, sameProcess, atomicJson } from '../../skill/scripts/parent-platform.mjs'
import { waitDelay, waitUntil, createLeaseCancellation, requestLeaseStop, finishLeaseExecution } from './scenarios-cancellation.mjs'
import { createNativeFixtureFactory } from './scenarios-fixtures.mjs'
import { openAiterm } from './aiterm.mjs'

const platform = { processIdentity, sameProcess, atomicJson }, runner = { commit: 'a'.repeat(40), modules_sha256: {} }
const moduleUrl = pathToFileURL(join(import.meta.dirname, 'scenarios-cancellation.mjs')).href
const scenariosUrl = pathToFileURL(join(import.meta.dirname, 'scenarios.mjs')).href
const platformUrl = pathToFileURL(join(import.meta.dirname, '../../skill/scripts/parent-platform.mjs')).href
const privateDir = t => { const dir = mkdtempSync(join(tmpdir(), 'pt-lease-interrupt-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }

test('24時間待機のabortはtimer/listenerを撤去し、cleanupの待機を打ち切らない', async () => {
  const controller = new AbortController(), summary = { cases: [] }; let probes = 0, cleanup = false
  const done = finishLeaseExecution({ summary, signal: controller.signal, save() {}, prepare: async () => {}, execute: () => waitUntil('通常24時間待機', () => { probes++; return false }, 86400000, 86400000, { signal: controller.signal }), cleanup: async () => { await waitDelay(25); cleanup = true; return { fixtures_closed: true } } })
  setTimeout(() => controller.abort('専用試験中断'), 20)
  await done
  const count = probes; await waitDelay(40)
  assert.equal(probes, count); assert.equal(cleanup, true); assert.equal(summary.status, 'failed'); assert.equal(summary.cleanup.status, 'passed')
  assert.equal(summary.errors[0].code, 'ACCEPTANCE_LEASE_INTERRUPTED'); assert.ok(summary.finished_at); assert.deepEqual(summary.cases, [])
})

const driver = mode => `
import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {createLeaseCancellation,finishLeaseExecution,waitUntil,closeOwnedChild} from ${JSON.stringify(moduleUrl)};
import {runScenario} from ${JSON.stringify(scenariosUrl)};import * as platform from ${JSON.stringify(platformUrl)};
const out=process.argv[2],mode=${JSON.stringify(mode)},runner=${JSON.stringify(runner)};
const control=createLeaseCancellation({out,pkg:out,runner,platform});
const summary={schema:'peertable.lease-run.v1',run_id:control.descriptor.run_id,owner:control.descriptor.owner,status:'running',cases:[]};
const save=()=>platform.atomicJson(join(out,'summary.json'),summary);save();
const assets=[];const owned=async()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},86400000)'],{stdio:'ignore'});assets.push(child);const owner=platform.processIdentity(child.pid);return owner};
try {await finishLeaseExecution({summary,signal:control.signal,save,prepare:async()=>{
summary.assets=[await owned(),await owned()];save();
if(mode==='prepare'){summary.waiting=mode;save();process.stdout.write('READY\\n');await waitUntil('準備中',()=>false,86400000,86400000,{signal:control.signal});}
return {harness:'claude',session:'own',pageChars:100,signal:control.signal,actions: mode==='missing'?{}:{lease_expiry_arm:async()=>{summary.waiting=mode;save();process.stdout.write('READY\\n');await waitUntil('実時間lease待機',()=>false,86400000,86400000,{signal:control.signal})},deliver:async()=>{},lease_expiry_observe:async()=>{},receiver_rearm:async()=>{},pending_recover:async()=>{}},finalize:async()=>{summary.finalized=true}};
},execute:context=>runScenario('lease',context),cleanup:async()=>{for(const child of assets)await closeOwnedChild(child);return {fixtures_closed:true,room:{exited:true},assets_gone:summary.assets.every(owner=>!platform.sameProcess(owner))}}});}finally{control.close()}
process.exitCode=summary.status==='passed'?0:1;
`
async function startDriver(t, mode) {
  const out = privateDir(t), file = join(out, 'driver.mjs'); writeFileSync(file, driver(mode))
  const child = spawn(process.execPath, [file, out], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  if (mode !== 'missing') await waitUntil('dummy controller待機開始', () => existsSync(join(out, 'summary.json')) && JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).waiting === mode, 10000, 10)
  return { out, child, exited, stderr: () => stderr }
}
for (const mode of ['prepare', 'action']) test(`${mode}待機を正規stop要求で中断し、実owned childとcontrollerを回収する`, async t => {
  const { out, child, exited, stderr } = await startDriver(t, mode)
  const result = await requestLeaseStop({ out, runner, platform, timeout: 15000 })
  assert.equal(result.controller_gone, true); assert.equal(result.cleanup.assets_gone, true); assert.equal(result.status, 'stopped')
  await exited; assert.equal(child.exitCode, 1, stderr())
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  for (const owner of summary.assets) assert.equal(Boolean(sameProcess(owner)), false)
  if (mode === 'action') assert.equal(summary.finalized, true)
})
test('adapter不足でもrunScenario.finallyを実行してowned child/roomを回収する', async t => {
  const { out, child, exited, stderr } = await startDriver(t, 'missing'); await exited
  assert.equal(child.exitCode, 1, stderr())
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  assert.equal(summary.finalized, true); assert.equal(summary.errors[0].code, 'ACCEPTANCE_SCENARIO_ADAPTER_MISSING'); assert.equal(summary.cleanup.assets_gone, true); assert.ok(summary.finished_at)
})
test('POSIX SIGTERMを専用runの協調中断へ適合する', { skip: process.platform === 'win32' }, async t => {
  const { out, child, exited, stderr } = await startDriver(t, 'action'); child.kill('SIGTERM'); await exited
  assert.equal(child.exitCode, 1, stderr()); assert.equal(child.signalCode, null)
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  assert.equal(summary.errors[0].code, 'ACCEPTANCE_LEASE_INTERRUPTED'); assert.equal(summary.cleanup.assets_gone, true); assert.ok(summary.finished_at)
})
test('異なるrun/controllerの停止要求を送らず、回収失敗を成功にしない', async t => {
  const out = privateDir(t), control = createLeaseCancellation({ out, pkg: out, runner, platform, signals: false })
  t.after(() => control.close())
  await assert.rejects(requestLeaseStop({ out, runner: { commit: 'b'.repeat(40) }, platform }), { code: 'ACCEPTANCE_LEASE_STOP_OWNER_MISMATCH' })
  assert.equal(existsSync(control.descriptor.request_file), false)
  const summary = { cases: [] }; await finishLeaseExecution({ summary, save() {}, prepare: async () => { throw Object.assign(new Error('準備と回収の失敗'), { cleanup: { status: 'failed' } }) }, execute() {}, cleanup: async () => ({ fixtures_closed: false }) })
  assert.equal(summary.cleanup.status, 'failed'); assert.equal(summary.status, 'failed'); assert.ok(summary.finished_at)
})
test('cleanup開始のsummary保存失敗でも所有資産の回収を実行する', async () => {
  const summary = { cases: [] }; let saved = 0, cleaned = false
  await finishLeaseExecution({ summary, prepare: async () => {}, execute: async () => {}, cleanup: async () => { cleaned = true; return { fixtures_closed: true } }, save() { if (++saved === 1) throw Object.assign(new Error('保存境界failure'), { code: 'EIO' }) } })
  assert.equal(cleaned, true); assert.equal(summary.status, 'failed'); assert.equal(summary.errors[0].code, 'EIO'); assert.equal(summary.cleanup.status, 'passed'); assert.ok(summary.finished_at)
})
test('factory.prepare途中の中断は登録済みown paneを閉じて実process消失を待つ', async t => {
  const out = privateDir(t), pkg = join(out, 'pkg'); const fs = await import('node:fs'); fs.mkdirSync(join(pkg, 'skill/scripts/parent-receivers'), { recursive: true })
  writeFileSync(join(pkg, 'skill/scripts/parent-platform.mjs'), `export * from ${JSON.stringify(platformUrl)};`)
  writeFileSync(join(pkg, 'skill/scripts/parent-runtime.mjs'), 'export const projectEndpoints=()=>[];')
  writeFileSync(join(pkg, 'skill/scripts/parent-connect.mjs'), 'export const ownsParentConnection=()=>false;')
  writeFileSync(join(pkg, 'skill/scripts/parent-receivers/codex.mjs'), 'export const codexConnection=()=>{throw new Error("focusedでは使いません")};')
  const signal = new AbortController(); let child, owner, closed = false
  const adapter = { resolveCli() {}, startup() {}, transcript() {}, read() {}, bind(fixture) { return { ...this, async prepare() {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},86400000)'], { stdio: 'ignore' }); owner = processIdentity(child.pid)
    fixture.pty = 'own-dummy-pane'; fixture.paneOwner = owner; fixture.nativeOwners.push(owner)
    fixture.aiterm = { observe: async () => ({ pane_process: { pid: child.pid } }), close: async name => { assert.equal(name, 'own-dummy-pane'); const { closeOwnedChild } = await import('./scenarios-cancellation.mjs'); await closeOwnedChild(child); closed = true }, end: async () => {} }
    setTimeout(() => signal.abort('prepare中断'), 20)
    await waitUntil('prepare', () => false, 86400000, 86400000, { signal: signal.signal })
  } } } }
  const factory = await createNativeFixtureFactory({ pkg, out, sourceMeta: { harness: 'grok', room: 'own' }, apiFor: () => {}, surfaceAdapters: { grok: adapter }, signal: signal.signal })
  await assert.rejects(factory.open(), { code: 'ACCEPTANCE_LEASE_INTERRUPTED' }); await factory.close()
  assert.equal(closed, true); assert.equal(Boolean(sameProcess(owner)), false)
})
test('Aiterm初期化途中の中断も自己stdio childを実回収する', async t => {
  const out = privateDir(t), file = join(out, 'unresponsive.mjs'), identity = join(out, 'owner.json')
  writeFileSync(file, `import {writeFileSync} from 'node:fs';import * as platform from ${JSON.stringify(platformUrl)};writeFileSync(process.argv[2],JSON.stringify(platform.processIdentity(process.pid)));process.stdin.on('data',()=>{});setInterval(()=>{},86400000);`)
  const controller = new AbortController(), pending = openAiterm({ executable: process.execPath, args: [file, identity], signal: controller.signal })
  await waitUntil('自己stdio起動', () => existsSync(identity), 10000, 10); controller.abort('init中断')
  await assert.rejects(pending, { code: 'ACCEPTANCE_LEASE_INTERRUPTED' }); assert.equal(Boolean(sameProcess(JSON.parse(readFileSync(identity, 'utf8')))), false)
})
