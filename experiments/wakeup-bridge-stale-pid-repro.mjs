#!/usr/bin/env node
// Windows は pid を再利用する。record の pid が生きているだけでは本人ではない。
// 2026-08-21: wakeup-bridge.json の pid が oracle-mcp に再利用され、ensure が
// 起動済みと誤認、キックオフが席へ届かなかった。stop が他人の pid を殺さないことも測る。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeRecordLive, updateBridgeProgress } from '../skill/scripts/bridge-record-live.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'peertable-stale-pid-'))
const project = join(root, 'project')
const record = join(project, '.team', 'wakeup-bridge.json')
mkdirSync(join(project, '.team'), { recursive: true })

const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
  stdio: 'ignore',
})
const dummyPid = dummy.pid
const sleep = ms => new Promise(r => setTimeout(r, ms))
let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok: ${label}`) }

try {
  dummy.unref?.()
  check('他人の生きた pid・progress 無しは死んだ記録', () => {
    if (!bridgeRecordLive({ pid: dummyPid, started_at: new Date().toISOString() })) return
    throw new Error('progress 無しを live にした')
  })
  check('他人の生きた pid・古い progress は死んだ記録', () => {
    const old = new Date(Date.now() - 120_000).toISOString()
    if (!bridgeRecordLive({ pid: dummyPid, last_progress_at: old })) return
    throw new Error('stale progress を live にした')
  })
  check('本人の pid・新しい progress は live', () => {
    if (bridgeRecordLive({ pid: dummyPid, last_progress_at: new Date().toISOString() })) return
    throw new Error('新しい progress を dead にした')
  })
  check('共通progress更新後のrecordは live', () => {
    const generic = join(project, '.team', 'generic-bridge.json')
    writeFileSync(generic, JSON.stringify({ pid: dummyPid, ready_at: new Date().toISOString() }) + '\n')
    updateBridgeProgress(generic, new Date())
    if (bridgeRecordLive(JSON.parse(readFileSync(generic, 'utf8')))) return
    throw new Error('progress更新後のrecordをdeadにした')
  })
  check('死んだ pid は progress が新しくても dead', () => {
    if (!bridgeRecordLive({ pid: 2_000_000_000, last_progress_at: new Date().toISOString() })) return
    throw new Error('存在しない pid を live にした')
  })

  writeFileSync(record, JSON.stringify({
    pid: dummyPid,
    started_at: new Date().toISOString(),
    room: 'fixture',
  }) + '\n')
  const stop = spawnSync(process.execPath, [join(REPO, 'skill/scripts/wakeup-bridge.mjs'), project, '--stop'], {
    encoding: 'utf8', timeout: 10_000,
  })
  check('--stop は他人の pid を殺さない', () => {
    if (stop.status !== 0) throw new Error(`stop rc=${stop.status}\n${stop.stderr}`)
    try { process.kill(dummyPid, 0) } catch { throw new Error('dummy が kill された') }
  })
  check('--stop は偽の record を外す', () => {
    try { readFileSync(record); throw new Error('record が残った') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  })

  writeFileSync(record, JSON.stringify({
    pid: dummyPid, started_at: new Date().toISOString(),
  }) + '\n')
  const live = spawnSync(process.execPath, [join(REPO, 'skill/scripts/bridge-record-live.mjs'), record], {
    encoding: 'utf8', timeout: 5_000,
  })
  check('ensure が見る live 判定は偽の pid を起動済みとしない', () => {
    if (live.status === 0) throw new Error('bridge-record-live が誤って成功した')
  })
  const ensureSrc = readFileSync(join(REPO, 'skill/scripts/ensure-bridge.sh'), 'utf8')
  check('ensure-bridge は pid-alive 単独ではなく record live を見る', () => {
    if (!ensureSrc.includes('bridge-record-live.mjs')) throw new Error('ensure-bridge が bridge-record-live を呼ばない')
    if (ensureSrc.includes('pid-alive.mjs')) throw new Error('ensure-bridge が pid-alive 単独判定のまま')
  })

  console.log(`wakeup-bridge stale pid repro: ${checks} checks green`)
} finally {
  try { process.kill(dummyPid, 'SIGTERM') } catch {}
  dummy.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
}
