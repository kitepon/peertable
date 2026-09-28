#!/usr/bin/env node
// 罠: `sent [937]` が room 保存と TUI 配達を区別せず、席・bridge 全停止の room への依頼を
// 「依頼済み」と誤認させた（2026-08-24 稼働状況不可視インシデント）。
// 保存 receipt と配送 receipt の分離（決定102）を固定する。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ParentSpool } from '../skill/scripts/parent-delivery.mjs'
import { processIdentity } from '../skill/scripts/parent-platform.mjs'
import { RoomApi } from '../skill/scripts/room-api.mjs'

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
  // native親も通常recipient。受付証拠はunknown更新後も不変。
  const endpoint = 'd8b62c71-85d6-40ae-834e-3560635f5230'
  await post('members', { name: 'native-parent', delivery: { kind: 'parent_receiver', harness: 'codex', endpoint_id: endpoint } })
  const native = await (await post('messages', { from: 'mio', to: 'all', body: '全件配送\n日本語' })).json()
  check('native親もallの宛先', native.delivery['native-parent']?.state === 'pending')
  const receipt = { seq: native.seq, recipient: 'native-parent', route: 'parent_receiver', endpoint_id: endpoint, receipt_revision: 1, result: 'delivered', queued_submission_id: 'official-queue-id', accepted_at: '2026-09-28T00:00:00Z' }
  check('native受付receipt', (await post('deliveries', receipt)).ok)
  check('異なる受付IDはtyped reject', (await post('deliveries', { ...receipt, queued_submission_id: 'wrong-queue-id' })).status === 409)
  check('異なる受付時刻はtyped reject', (await post('deliveries', { ...receipt, accepted_at: '2026-09-28T01:00:00Z' })).status === 409)
  await post('deliveries', { seq: native.seq, recipient: 'native-parent', result: 'unknown', route: 'parent_receiver', endpoint_id: endpoint, receipt_revision: 2, reason: 'hook_output_unknown' })
  const unknown = (await (await fetch(`${base}/deliveries?seq=${native.seq}`)).json()).delivery['native-parent']
  check('unknownは公開され受付証拠が残る', unknown.state === 'unknown' && unknown.queued_submission_id === receipt.queued_submission_id && unknown.accepted_at === receipt.accepted_at)
  // AのHTTPを保留し、別processのBがunknownを先に確定してから古いAを後着させる。
  const racedMessage = await (await post('messages', { from: 'mio', to: 'native-parent', body: 'receipt順序反転' })).json()
  const credential = join(root, 'receipt-token'); writeFileSync(credential, TOKEN, { mode: 0o600 })
  const spool = ParentSpool.create(root, { endpoint_id: endpoint, name: 'native-parent', room: ROOM, server_url: `http://127.0.0.1:${port}`, credential, start_seq: 0, harness: 'codex', caller: { conversation: 'fixture', owner: processIdentity(process.pid) } })
  spool.saveEvent({ type: 'parent_dm', seq: racedMessage.seq, body: 'receipt順序反転' })
  const record = spool.claim('codex_queue'), accepted = { queued_submission_id: 'race-official-id', accepted_at: '2026-09-28T02:00:00Z' }
  spool.finish(record, accepted)
  const roomApi = new RoomApi(spool.read(), { credential }); let releaseA, startedA
  const started = new Promise(resolve => { startedA = resolve }), delayA = new Promise(resolve => { releaseA = resolve })
  const flushA = spool.flushReceipts({ request: async (path, args) => { startedA(); await delayA; return roomApi.request(path, args) } })
  await started
  const code = `import {ParentSpool} from ${JSON.stringify(new URL('../skill/scripts/parent-delivery.mjs', import.meta.url).href)};import {RoomApi} from ${JSON.stringify(new URL('../skill/scripts/room-api.mjs', import.meta.url).href)};const s=new ParentSpool(process.argv[1],process.argv[2]);s.finish(s.read().records[0],{state:'unknown',reason:'hook_output_unknown'});await s.flushReceipts(new RoomApi(s.read(),{credential:s.read().credential}));`
  const childB = spawn(process.execPath, ['--input-type=module', '-e', code, root, endpoint], { stdio: ['ignore', 'ignore', 'pipe'] }); let childError = ''
  childB.stderr.on('data', chunk => { childError += chunk })
  const [childStatus] = await once(childB, 'exit'); if (childStatus !== 0) throw new Error(childError)
  releaseA(); await flushA
  const raced = (await (await fetch(`${base}/deliveries?seq=${racedMessage.seq}`)).json()).delivery['native-parent']
  check('別processのunknown後に古いdeliveredが到着しても消さない', raced.state === 'unknown' && raced.receipt_revision === 2 && spool.read().records[0].state === 'unknown' && spool.read().records[0].receipt.pending === false)
  spool.finish(record, { ...accepted, resolve_unknown: true, reason: 'official_output_complete' }); await spool.flushReceipts(roomApi)
  const resolved = (await (await fetch(`${base}/deliveries?seq=${racedMessage.seq}`)).json()).delivery['native-parent']
  check('公式出力証拠の新revisionはunknownを解消し受付ID/時刻を保つ', resolved.state === 'delivered' && resolved.receipt_revision === 3 && resolved.queued_submission_id === accepted.queued_submission_id && resolved.accepted_at === accepted.accepted_at)
  await post('bridges', { kind: 'parent_receiver', recipient: 'native-parent', endpoint_id: endpoint, state: 'rearm_pending' })
  const health = (await (await fetch(`${base}/members`)).json()).bridges.parent_receiver
  check('再武装不足はhealthyにしない', health.state === 'rearm_pending')
  await post('members', { name: 'native-parent', delivery: { kind: 'parent_receiver', harness: 'codex', endpoint_id: 'a5b18e30-a4bd-4d99-81db-e24c2789a726' } })
  check('旧endpointのreceiptは拒否', (await post('deliveries', receipt)).status === 409)
  check('旧endpointのhealthは拒否', (await post('bridges', { kind: 'parent_receiver', recipient: 'native-parent', endpoint_id: endpoint, state: 'armed' })).status === 409)
} finally {
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), sleep(1000)])
  rmSync(root, { recursive: true, force: true })
}
process.exit(checks.every(c => c.condition) ? 0 : 1)
