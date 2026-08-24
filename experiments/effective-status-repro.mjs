#!/usr/bin/env node
// 罠: 閲覧面ごとの独自鮮度判定で、MCP からは席の停止・bridge 停止・403 が見えなかった
// （2026-08-24 稼働状況不可視インシデント）。server が実効状態を一元生成すること（決定101・103）を固定する。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = 'effective-status-repro-token'
const ROOM = 'effective-status-repro'
const STALE_MS = 1500 // 実運用 90 秒の縮小版（env で server の閾値を縮める）
const root = mkdtempSync(join(tmpdir(), 'peertable-effective-status-'))

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
  env: {
    ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: root,
    PEERTABLE_POST_TOKEN: TOKEN, PEERTABLE_STATUS_STALE_MS: String(STALE_MS),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const base = `http://127.0.0.1:${port}/api/${ROOM}`
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/messages`)).ok) break } catch {}
    await sleep(50)
  }

  // 1) 状態未報告・bridge 未登録: unknown へ落ち、理由が bridge 未登録を指す
  await fetch(`${base}/members`, { method: 'POST', headers, body: JSON.stringify({ name: 'mio', harness: 'claude' }) })
  let { members, bridges } = await (await fetch(`${base}/members`)).json()
  check('未報告の席は status_effective=unknown', members[0].status_effective === 'unknown')
  check('理由が status_bridge_unreported', members[0].status_reason === 'status_bridge_unreported', members[0].status_reason)
  check('bridge 台帳も status_bridge_unreported', bridges.seat_status.state === 'status_bridge_unreported')

  // 2) bridge 心拍 + fresh 状態: 実効状態が生の status のまま通る
  await fetch(`${base}/bridges`, { method: 'POST', headers, body: JSON.stringify({ kind: 'seat_status', pid: 1234, state: 'running' }) })
  await fetch(`${base}/members`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'mio', status: 'busy', status_at: new Date().toISOString(), usage_source: 'pane_status' }),
  })
  ;({ members, bridges } = await (await fetch(`${base}/members`)).json())
  check('bridge 心拍後は up', bridges.seat_status.state === 'up')
  check('fresh な報告は実効状態にそのまま出る', members[0].status_effective === 'busy' && members[0].status_reason === 'fresh')
  check('status_age_ms が付く', Number.isFinite(members[0].status_age_ms))

  // 3) 閾値経過: 状態も bridge も途絶 → unknown / status_bridge_down（受入条件2の縮小版実測）
  await sleep(STALE_MS + 300)
  ;({ members, bridges } = await (await fetch(`${base}/members`)).json())
  check('心拍途絶で bridge が status_bridge_down', bridges.seat_status.state === 'status_bridge_down')
  check('途絶した席は unknown へ落ちる', members[0].status_effective === 'unknown')
  check('理由が status_bridge_down', members[0].status_reason === 'status_bridge_down', members[0].status_reason)

  // 3b) bridge は生きているが席の報告だけ古い: 理由は heartbeat 途絶
  await fetch(`${base}/bridges`, { method: 'POST', headers, body: JSON.stringify({ kind: 'seat_status', pid: 1234 }) })
  ;({ members } = await (await fetch(`${base}/members`)).json())
  check('bridge 生存・報告 stale は status_heartbeat_stale', members[0].status_reason === 'status_heartbeat_stale', members[0].status_reason)

  // 4) 403: 書込が拒否された事実を server が観測し、bridge_auth_failed として実効表示する（受入条件3）
  const denied = await fetch(`${base}/members`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': 'wrong' },
    body: JSON.stringify({ name: 'mio', status: 'idle', status_at: new Date().toISOString(), usage_source: 'pane_status' }),
  })
  check('token 不一致は 403', denied.status === 403)
  ;({ members, bridges } = await (await fetch(`${base}/members`)).json())
  check('403 観測で bridge_auth_failed', bridges.seat_status.state === 'bridge_auth_failed', bridges.seat_status.state)
  check('席の理由も bridge_auth_failed', members[0].status_reason === 'bridge_auth_failed')

  // 5) 正常心拍で 403 観測が消える
  await fetch(`${base}/bridges`, { method: 'POST', headers, body: JSON.stringify({ kind: 'seat_status', pid: 1234 }) })
  ;({ bridges } = await (await fetch(`${base}/members`)).json())
  check('正常心拍で up へ戻る', bridges.seat_status.state === 'up')

  // 6) 一般書込（bridge 由来と分類できない）の 403 は bridge 障害として記録しない
  await fetch(`${base}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': 'wrong' },
    body: JSON.stringify({ from: 'x', to: 'all', body: 'hi' }),
  })
  ;({ bridges } = await (await fetch(`${base}/members`)).json())
  check('一般書込の 403 は bridge_auth_failed にしない', bridges.seat_status.state === 'up' && bridges.wakeup.state !== 'bridge_auth_failed')

  // 7) Web UI は server 生成の実効状態を読む（独自の鮮度計算を持たない）＝ MCP と判定が一致する（受入条件9）
  const ui = await (await fetch(`http://127.0.0.1:${port}/${ROOM}`)).text()
  check('UI が status_effective を読む', ui.includes('m.status_effective'))
  check('UI に独自の鮮度計算が残っていない', !ui.includes('STATUS_STALE_MS'))
} finally {
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), sleep(1000)])
  rmSync(root, { recursive: true, force: true })
}
process.exit(checks.every(c => c.condition) ? 0 : 1)
