#!/usr/bin/env node
// 罠: 席のTUIが消えた卓で wakeup-bridge が (1) 同じ seq を2秒ごとに永遠に再試行し
// （打ち切りが delivered 台帳に残らず、再起動で蘇る）、(2) 再起動のたびに同じ [配達失敗] DM を
// room へ再投稿した（通知済み集合がメモリだけ）。2026-08-30 実測: 席全滅の卓で seq 2件が
// 18時間・3.7万行の SEAT_TUI_GONE を刻み、公開feedの末尾78件が同一通知の13重複で埋まった。
// 固定する契約: 席不在の連続失敗は打ち切られ、打ち切りと通知済みは bridge 再起動を跨いで保持される。
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ROOM = 'wakeup-dead-seat-abandon-repro'
const TOKEN = 'wakeup-dead-seat-repro-token'
const root = mkdtempSync(join(tmpdir(), 'peertable-dead-seat-'))
const proj = join(root, 'proj')
const dataDir = join(root, 'data')
const socket = join(root, 'tmux.sock')
mkdirSync(join(proj, '.team'), { recursive: true })

async function freePort() {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')
  return port
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (label, condition, detail = '') => {
  checks.push({ label, condition })
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1_500)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const port = await freePort()
const url = `http://127.0.0.1:${port}`
writeFileSync(join(proj, '.team', 'setup-state.json'), JSON.stringify({ room: ROOM, server_url: url }) + '\n')
const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: dataDir, PEERTABLE_POST_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
const post = (path, body) => fetch(`${url}/api/${ROOM}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
const messages = async () => (await (await fetch(`${url}/api/${ROOM}/messages`)).json()).messages
const failures = list => list.filter(m => typeof m.body === 'string' && m.body.startsWith('[配達失敗]'))
const bridgeEnv = {
  ...process.env,
  PEERTABLE_POST_TOKEN: TOKEN,
  PEERTABLE_PARENT_NAME: 'bell',
  PEERTABLE_GONE_ABANDON_CYCLES: '3', // 実運用は150周期≈5分。harness は待ち時間だけを縮める
}
// bridge は log を stdout/stderr に書く（本番は supervisor がファイルへ流し込む）。ここで自前捕捉する
let bridgeLog = ''
const spawnBridge = () => {
  const child = spawn(process.execPath, [BRIDGE, proj], { env: bridgeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { bridgeLog += chunk })
  child.stderr.on('data', chunk => { bridgeLog += chunk })
  return child
}
const readLog = () => bridgeLog
let bridge = null
let tmuxReady = false
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${url}/api/rooms`)).ok) break } catch {}
    await sleep(50)
  }
  // tmux server は生きているが、席の pane は存在しない＝実被弾と同じ形（session ごと死亡）
  execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'keeper', '-x', '80', '-y', '24', 'sleep 600'])
  tmuxReady = true
  await post('members', { name: 'bell', delivery: { kind: 'parent_watch' } })
  await post('members', { name: 'ghost', harness: 'claude', observe: { tmux_socket: socket, tmux_target: 'peer-ghost' } })

  bridge = spawnBridge()
  await sleep(3_000)
  await post('messages', { from: 'bell', to: 'ghost', body: '死んだ席への依頼（配達不能の実測用）' })

  // streak2 で親宛通知1通 → 3周期で打ち切り。周期2秒なので12秒で両方が確定する
  await sleep(12_000)
  const before = await messages()
  check('親宛 [配達失敗] はちょうど1通', failures(before).length === 1, `実測 ${failures(before).length}通`)
  const abandoned = readLog().includes('DELIVERY_ABANDONED')
  check('打ち切り（DELIVERY_ABANDONED）が発動する', abandoned)
  if (!abandoned) console.log('---- bridge log tail ----\n' + readLog().split('\n').slice(-25).join('\n'))

  // bridge 再起動＝launchd の生存保証と同じ動き。ここで通知の再投稿と再試行が蘇るのが欠陥版
  await stop(bridge)
  const logLenAtRestart = readLog().length
  bridge = spawnBridge()
  await sleep(8_000)
  const after = await messages()
  const restartedLog = readLog().slice(logLenAtRestart)
  check('再起動後も [配達失敗] は増えない（通知済みが耐再起動）', failures(after).length === 1, `実測 ${failures(after).length}通`)
  check('再起動後に同じ seq の再試行が蘇らない（打ち切りが耐再起動）', !restartedLog.includes('WAKEUP_BRIDGE_DELIVERY_FAILURE'))
} finally {
  await stop(bridge)
  server.kill('SIGTERM')
  if (tmuxReady) { try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {} }
  rmSync(root, { recursive: true, force: true })
}
const failed = checks.filter(c => !c.condition)
console.log(failed.length === 0 ? 'PASS wakeup-dead-seat-abandon-repro' : `FAIL wakeup-dead-seat-abandon-repro (${failed.length}/${checks.length})`)
process.exit(failed.length === 0 ? 0 : 1)
