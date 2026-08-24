#!/usr/bin/env node
// 罠: 円卓 kickoff を「roomへの投稿成功＋静的メンバー一覧」だけで稼働中と判定し、
// 停止した卓へ依頼したまま監査が未実施になった（2026-08-24 稼働状況不可視インシデント）。
// kickoff-gate の3条件（fresh 状態・delivered receipt・引受発言）を固定する（決定104・受入条件6）。
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = join(REPO, 'skill/scripts/kickoff-gate.mjs')
const TOKEN = 'kickoff-gate-repro-token'
const ROOM = 'kickoff-gate-repro'
const root = mkdtempSync(join(tmpdir(), 'peertable-kickoff-gate-'))
const proj = join(root, 'proj')
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

const port = await freePort()
const url = `http://127.0.0.1:${port}`
writeFileSync(join(proj, '.team', 'setup-state.json'), JSON.stringify({ room: ROOM, server_url: url }) + '\n')
const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: join(root, 'data'), PEERTABLE_POST_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const base = `${url}/api/${ROOM}`
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
const gate = (seq, seats) => {
  const result = spawnSync(process.execPath, [GATE, proj, '--seq', String(seq), '--seats', seats, '--json'], { encoding: 'utf8' })
  return { code: result.status, body: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr }
}
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/messages`)).ok) break } catch {}
    await sleep(50)
  }

  await post('members', { name: 'mio', harness: 'claude', observe: { tmux_socket: '/tmp/x.sock', tmux_target: 'peer-mio' } })
  await post('bridges', { kind: 'wakeup', pid: 1, state: 'running' })
  await post('bridges', { kind: 'seat_status', pid: 2, state: 'running' })
  const kickoff = await (await post('messages', { from: 'bell', to: 'mio', body: '[kickoff] 設計反証を依頼。引受を [引受] で返すこと' })).json()

  // 1) 状態未報告・receipt なし・引受なし → pending（exit 3）
  let g = gate(kickoff.seq, 'mio')
  check('3条件ゼロは pending', g.code === 3 && g.body.state === 'pending', JSON.stringify(g.body ?? g.stderr))
  check('状態 NG の理由が出る', g.body.seats.mio.status.reason !== 'fresh')

  // 2) fresh 状態だけでは active にならない
  await post('members', { name: 'mio', status: 'idle', status_at: new Date().toISOString(), usage_source: 'pane_status' })
  g = gate(kickoff.seq, 'mio')
  check('fresh 状態のみは pending', g.code === 3 && g.body.seats.mio.delivery.state !== 'delivered')

  // 3) delivered receipt が揃っても引受が無ければ pending（受入条件6: receipt なしで active にならない、の裏も固定）
  await post('deliveries', { seq: kickoff.seq, recipient: 'mio', result: 'delivered' })
  g = gate(kickoff.seq, 'mio')
  check('receipt 済みでも引受なしは pending', g.code === 3 && g.body.seats.mio.ack === null)

  // 4) 席が引受を返して3条件成立 → active（exit 0）
  await post('messages', { from: 'mio', to: 'all', body: '[引受] 設計反証を担当する' })
  g = gate(kickoff.seq, 'mio')
  check('3条件成立で active', g.code === 0 && g.body.state === 'active', JSON.stringify(g.body ?? g.stderr))
  check('引受の seq を指す', g.body.seats.mio.ack?.seq > kickoff.seq)

  // 5) 実在しない席を対象に含めると pending のまま
  g = gate(kickoff.seq, 'mio,ghost')
  check('不在席が混じれば pending', g.code === 3 && g.body.seats.ghost.status.reason === 'member_not_found')

  // 6) receipt を欠いた状態で状態と引受だけ揃えても active にならない（受入条件6の直接形）
  const kickoff2 = await (await post('messages', { from: 'bell', to: 'mio', body: '[kickoff] 第二依頼' })).json()
  await post('messages', { from: 'mio', to: 'all', body: '[引受] 第二依頼も担当する' })
  g = gate(kickoff2.seq, 'mio')
  check('配送 receipt なしでは active にならない', g.code === 3 && g.body.seats.mio.delivery.state !== 'delivered', JSON.stringify(g.body?.seats.mio))
} finally {
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), sleep(1000)])
  rmSync(root, { recursive: true, force: true })
}
process.exit(checks.every(c => c.condition) ? 0 : 1)
