import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchDetached, parseWmiResult } from './parent-process.mjs'
import { processIdentity, sameProcess } from './parent-platform.mjs'

// 全OS共通の契約: env全量・cwd・argv・stdin無効・同じlogへのstdout/stderr・pid+開始identityでの生死。
test('launchDetachedはenv/cwd/argv/stdin/logの契約をOS間で同じに保つ', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peertable-launch-'))), work = join(root, '作業 dir'), log = join(root, 'watch.log')
  mkdirSync(work)
  const probe = join(root, 'probe.mjs'), report = join(root, 'report.json')
  writeFileSync(probe, `
import { writeFileSync } from 'node:fs'
const stdinEnded = await new Promise(resolve => { process.stdin.on('end', () => resolve(true)); process.stdin.on('error', () => resolve(true)); process.stdin.resume(); setTimeout(() => resolve(false), 2000) })
console.log('stdout-line'); console.error('stderr-line')
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdinEnded }))
setInterval(() => {}, 1000)
`)
  const args = [probe, 'a b', 'q"uote', '日本語', 'tail\\', "it's"]
  const env = { ...process.env, PEERTABLE_CREDENTIAL_FILE: join(root, 'cred file'), PEERTABLE_WATCH_NO_STDIN: '1', PT_LAUNCH_VALUE: '日本語 "値" \'x\' %PATH%' }
  const pid = launchDetached({ executable: process.execPath, args, cwd: work, env, logFile: log, onError: error => { throw error } })
  let identity
  t.after(() => { try { process.kill(pid) } catch {} rmSync(root, { recursive: true, force: true }) })
  const deadline = Date.now() + 20000
  while (!existsSync(report) && Date.now() < deadline) await delay(50)
  const seen = JSON.parse(readFileSync(report, 'utf8'))
  assert.deepEqual(seen.argv, args.slice(1))
  assert.equal(seen.cwd.replaceAll('\\', '/').toLowerCase(), work.replaceAll('\\', '/').toLowerCase())
  assert.equal(seen.stdinEnded, true)
  for (const [name, value] of Object.entries(env)) if (!name.startsWith('=')) assert.equal(seen.env[name], value, `env ${name}`)
  const text = readFileSync(log, 'utf8')
  assert.match(text, /stdout-line/u); assert.match(text, /stderr-line/u)
  identity = processIdentity(pid)
  assert.equal(identity.pid, pid)
  assert.ok(sameProcess(identity))
  process.kill(pid)
  const stop = Date.now() + 10000
  while (sameProcess(identity) && Date.now() < stop) await delay(50)
  assert.equal(sameProcess(identity), false)
  assert.equal(existsSync(join(root, 'watch.launch.json')), false)
})

test('WMIの壊れた/欠けた/非0応答はPARENT_WATCH_START_FAILEDになる', () => {
  for (const raw of ['not json', '', '{}', '{"return_value":0}', '{"pid":5}', '{"return_value":"0","pid":5}', '{"return_value":0,"pid":0}', 'null', '{"return_value":9,"pid":5}']) {
    assert.throws(() => parseWmiResult(raw), { code: 'PARENT_WATCH_START_FAILED' }, JSON.stringify(raw))
  }
  assert.equal(parseWmiResult('{"return_value":0,"pid":5}').pid, 5)
})

// bootstrapの起動失敗(log open/cwd/executable)はhandshakeへtyped失敗を書いて終了する。
test('bootstrapは起動失敗をhandshakeへ書いて終了する', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peertable-bootstrap-')))
  try {
    for (const [label, log, cwd, executable] of [['open', join(root, 'nodir', 'w.log'), root, process.execPath], ['cwd', join(root, 'w.log'), join(root, 'nocwd'), process.execPath], ['exe', join(root, 'w.log'), root, join(root, 'noexe')]]) {
      const handshake = join(root, `${label}.json`)
      const run = spawnSync(process.execPath, [fileURLToPath(new URL('./parent-process.mjs', import.meta.url)), '--bootstrap', handshake, log, cwd, executable, '-e', '0'], { encoding: 'utf8', timeout: 15000 })
      assert.equal(run.status, 1, `${label}: ${run.stderr}`)
      assert.equal(typeof JSON.parse(readFileSync(handshake, 'utf8')).error, 'string', label)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
