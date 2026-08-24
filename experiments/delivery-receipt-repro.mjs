#!/usr/bin/env node
// 罠: `sent [937]` が room 保存と TUI 配達を区別せず、席・bridge 全停止の room への依頼を
// 「依頼済み」と誤認させた（2026-08-24 稼働状況不可視インシデント）。
// 保存 receipt と配送 receipt の分離（決定102）を固定する。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = 'delivery-receipt-repro-token'
const ROOM = 'delivery-receipt-repro'
const root = mkdtempSync(join(tmpdir(), 'peertable-delivery-receipt-'))

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

const port = await freePort()
const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: root, PEERTABLE_POST_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const base = `http://127.0.0.1:${port}/api/${ROOM}`
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/messages`)).ok) break } catch {}
    await sleep(50)
  }

  // 席の台帳: TUI 席 mio（observe あり）・親 bell（parent_watch）・配達経路なし noko
  await post('members', { name: 'mio', harness: 'claude', observe: { tmux_socket: '/tmp/x.sock', tmux_target: 'peer-mio' } })
  await post('members', { name: 'bell', delivery: { kind: 'parent_watch' } })
  await post('members', { name: 'noko' })

  // 1) 実在しない宛先: room_saved は true だが delivery は seat_unavailable（受入条件1・4）
  const ghost = await (await post('messages', { from: 'bell', to: 'ghost', body: '依頼' })).json()
  check('post 応答に room_saved:true', ghost.room_saved === true)
  check('実在しない宛先は seat_unavailable', ghost.delivery.ghost?.state === 'seat_unavailable', JSON.stringify(ghost.delivery))
  check('理由が member_not_found', ghost.delivery.ghost?.reason === 'member_not_found')

  // 2) wakeup bridge 不在: 席は居ても bridge_unavailable（保存成功≠依頼済み。受入条件4）
  const noBridge = await (await post('messages', { from: 'bell', to: 'mio', body: '依頼A' })).json()
  check('bridge 不在は bridge_unavailable', noBridge.delivery.mio?.state === 'bridge_unavailable', JSON.stringify(noBridge.delivery))
  check('理由に bridge の実効状態', noBridge.delivery.mio?.reason === 'wakeup_bridge_unreported')

  // 3) bridge 心拍後: pending（保存済み・配達待ち。delivered にはならない）
  await post('bridges', { kind: 'wakeup', pid: 4321, state: 'running' })
  const pendingMsg = await (await post('messages', { from: 'bell', to: 'mio', body: '依頼B' })).json()
  check('bridge 生存時の初期状態は pending', pendingMsg.delivery.mio?.state === 'pending', JSON.stringify(pendingMsg.delivery))
  check('post 成功だけでは delivered にならない', pendingMsg.delivery.mio?.state !== 'delivered')

  // 4) GET /deliveries が同じ判定を返す（親が後から照会する経路）
  const q1 = await (await fetch(`${base}/deliveries?seq=${pendingMsg.seq}`)).json()
  check('照会 schema', q1.schema === 'peertable.delivery.v1')
  check('照会でも pending', q1.delivery.mio?.state === 'pending')

  // 5) receipt は TUI 投入後にだけ作られる（wakeup-bridge の書込を模す。受入条件5）
  await post('deliveries', { seq: pendingMsg.seq, recipient: 'mio', result: 'delivered' })
  const q2 = await (await fetch(`${base}/deliveries?seq=${pendingMsg.seq}`)).json()
  check('receipt 後は delivered', q2.delivery.mio?.state === 'delivered', JSON.stringify(q2.delivery))
  check('receipt に at が付く', typeof q2.delivery.mio?.at === 'string')

  // 6) 席不在 receipt → 再試行成功で delivered へ上書き（upsert）
  const retryMsg = await (await post('messages', { from: 'bell', to: 'mio', body: '依頼C' })).json()
  await post('deliveries', { seq: retryMsg.seq, recipient: 'mio', result: 'seat_unavailable', reason: 'SEAT_TUI_GONE' })
  const q3 = await (await fetch(`${base}/deliveries?seq=${retryMsg.seq}`)).json()
  check('席不在 receipt が見える', q3.delivery.mio?.state === 'seat_unavailable' && q3.delivery.mio?.reason === 'SEAT_TUI_GONE')
  await post('deliveries', { seq: retryMsg.seq, recipient: 'mio', result: 'delivered' })
  const q4 = await (await fetch(`${base}/deliveries?seq=${retryMsg.seq}`)).json()
  check('再試行成功で delivered へ上書き', q4.delivery.mio?.state === 'delivered')

  // 7) broadcast: 送信者を除く全員が宛先。親は parent_watch 経由、配達経路なしは seat_unavailable
  const bc = await (await post('messages', { from: 'mio', to: 'all', body: '共有' })).json()
  check('broadcast の宛先は送信者以外', !('mio' in bc.delivery) && 'bell' in bc.delivery && 'noko' in bc.delivery, JSON.stringify(bc.delivery))
  check('親は parent_watch 経由の pending', bc.delivery.bell?.state === 'pending' && bc.delivery.bell?.reason === 'parent_watch経由')
  check('配達経路の無い member は seat_unavailable', bc.delivery.noko?.state === 'seat_unavailable' && bc.delivery.noko?.reason === 'no_delivery_route')

  // 8) receipt の検証: result 語彙外・seq 不正は 400
  check('result 語彙外は 400', (await post('deliveries', { seq: 1, recipient: 'mio', result: 'ok' })).status === 400)
  check('seq 不正は 400', (await post('deliveries', { seq: 0, recipient: 'mio', result: 'delivered' })).status === 400)
  check('存在しない seq の照会は 404', (await fetch(`${base}/deliveries?seq=9999`)).status === 404)
} finally {
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), sleep(1000)])
  rmSync(root, { recursive: true, force: true })
}
process.exit(checks.every(c => c.condition) ? 0 : 1)
