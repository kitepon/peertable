#!/usr/bin/env node
// room のSSEを購読し、明示宛先の新着を current member descriptor の通常席 TUI へ
// 素送信する。専用の起床デーモンではない。親は parent-watch が所有し、ここでは扱わない。
//
// usage: wakeup-bridge.mjs <project_dir> [legacy-seat...]     起動（前面。nohup で常駐させる）
//        wakeup-bridge.mjs <project_dir> --stop               停止
//
// 生死の作法は Lattice ADR 0157 に倣う: 自分の pid を記録に置き、起動時に前の記録を掃除し、
// 止まらなければ黙って諦めず typed error で落ちる。
//
// 実測（2026-08-08・Codex CLI v0.146.0）: Codex は**ターン実行中でも素送信を受け付ける**。
// 送った文言はそのターンの中で読まれ、指示どおりに動いた（steering が効く）。
// 実測（2026-08-17・Grok Build TUI）: Grok 既定は follow_up_behavior=queue。素送信は
// 今のターンへ混ざらず入力キューへ積まれ、次の user ターンになる。Grok 席だけ idle を待つ。
import { execFile } from 'node:child_process'
import {
  existsSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { classifyPaneTail, resolvePostToken, resolveSeatObservation, tmuxArgv } from './seat-usage.mjs'
import { keysForCodexPane } from './codex-dialog.mjs'
import { BROADCAST_RECIPIENT, formatWakeNotice, isIdleSelfWake, isWakeupBridgeTarget, memberHarness, shouldDeferGrokWake } from './wakeup-delivery.mjs'
import { bridgeRecordLive } from './bridge-record-live.mjs'

const run = promisify(execFile)
const [proj, ...rest] = process.argv.slice(2)
if (!proj) {
  console.error('usage: wakeup-bridge.mjs <project_dir> <seat> [seat...] | <project_dir> --stop')
  process.exit(1)
}

const record = join(proj, '.team', 'wakeup-bridge.json')
const deliveryStatePath = join(proj, '.team', 'wakeup-bridge-delivery.json')
const startupLock = `${record}.lock`
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = line => console.log(`[${new Date().toISOString()}] ${line}`)
let lockHeld = false
const releaseStartupLock = () => {
  if (!lockHeld) return
  try { if (existsSync(startupLock)) unlinkSync(startupLock) } catch {}
  lockHeld = false
}
process.on('exit', releaseStartupLock)

async function acquireStartupLock() {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      writeFileSync(startupLock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      lockHeld = true
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = null
      try { owner = Number(readFileSync(startupLock, 'utf8').trim()) } catch {}
      if (owner !== null && Number.isInteger(owner) && !alive(owner)) {
        try { unlinkSync(startupLock) } catch {}
        continue
      }
      if (Date.now() >= deadline) {
        console.error(`WAKEUP_BRIDGE_START_LOCKED: 起動処理中のbridge（pid ${owner ?? '不明'}）がlockを保持している`)
        process.exit(1)
      }
      await sleep(200)
    }
  }
}

function readRecord() {
  try { return JSON.parse(readFileSync(record, 'utf8')) } catch { return null }
}

function writeRecord(next) {
  const temp = `${record}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(next) + '\n')
  renameSync(temp, record)
}

function touchProgress() {
  if (!existsSync(record)) return
  const current = readRecord()
  if (!current || current.pid !== process.pid) return
  writeRecord({ ...current, last_progress_at: new Date().toISOString() })
}

async function stopRecorded() {
  if (!existsSync(record)) return
  const saved = readRecord()
  const pid = Number(saved?.pid)
  if (!bridgeRecordLive(saved)) {
    unlinkSync(record)
    log(`他人の pid または死んだ記録を掃除した（pid ${Number.isInteger(pid) ? pid : '不明'}）。kill しない`)
    return
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 25 && alive(pid); i++) await sleep(200)
  if (alive(pid)) {
    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 15 && alive(pid); i++) await sleep(200)
  }
  if (alive(pid)) {
    console.error(`WAKEUP_BRIDGE_STOP_FAILED: pid ${pid} が SIGKILL でも止まらない`)
    process.exit(1)
  }
  if (existsSync(record)) unlinkSync(record)
  log(`前のブリッジを停止した（pid ${pid}）`)
}

await acquireStartupLock()
await stopRecorded()
if (rest[0] === '--stop') process.exit(0)

// 起動引数は supervisor の後方互換として記録するだけで、配送対象の正本にはしない。
// 宛先は常に room の現在 member name から descriptor を解決する。
const requestedSeats = rest
const state = JSON.parse(readFileSync(join(proj, '.team', 'setup-state.json'), 'utf8'))
const { room, server_url: url } = state
const parentName = (() => {
  if (process.env.PEERTABLE_PARENT_NAME) return process.env.PEERTABLE_PARENT_NAME
  try {
    const watch = JSON.parse(readFileSync(join(proj, '.team', 'parent-watch.json'), 'utf8'))
    return typeof watch.parent === 'string' ? watch.parent : null
  } catch {
    return null
  }
})()
const targetOpts = { parentName }
writeRecord({
  pid: process.pid, room, server_url: url, requested_seats: requestedSeats,
  started_at: new Date().toISOString(), last_progress_at: new Date().toISOString(),
})
releaseStartupLock()

const cleanup = () => { if (existsSync(record)) unlinkSync(record); process.exit(0) }
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)

// ---- 心拍と配送 receipt（決定102・103）--------------------------------------------
// 心拍が 90 秒途絶えると server が wakeup_bridge_down、書込 403 は server が bridge_auth_failed
// として実効表示する。receipt は TUI 投入の成立確認後にだけ delivered を書き、席不在系は
// seat_unavailable を書く——room 保存を配達成功と見せる面を server 側から潰すための唯一の書き手。
const postToken = resolvePostToken(process.env)
const writeHeaders = { 'Content-Type': 'application/json', ...(postToken ? { 'X-Peertable-Token': postToken } : {}) }
const BEAT_MS = 30_000
let lastBeatAt = 0
let beatSupported = null
async function beatBridge() {
  const now = Date.now()
  if (beatSupported === false || now - lastBeatAt < BEAT_MS) return
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/bridges`, {
      method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ kind: 'wakeup', pid: process.pid, state: 'running' }),
    })
    if (res.status === 404) {
      beatSupported = false
      log('server が bridge 台帳を持たない版（404）。心拍送信を止める')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    beatSupported = true
    lastBeatAt = now
  } catch (error) {
    log(`WAKEUP_BRIDGE_BEAT_FAILED: ${error.message}`)
  }
}
let receiptSupported = null
const postedReceipts = new Map() // `${seq}:${recipient}` -> `${result}:${reason}`（同内容の再送を抑える）
// 配達失敗は台帳（pull）に書くだけでは親に届かない（実被弾 2026-08-29: 裁定DMのSTUCKが
// 1時間誰にも知られず放置された。オーナー裁定「配達失敗だけ届ければいい」）。
// failed / seat_unavailable の初回だけ、親宛DMを1通送る——親宛DMは parent-watch が起こすので
// 既存の通知経路にそのまま乗り、この bridge 自身は親へ配達しないため再帰しない。
const notifiedFailures = new Set() // `${seq}:${recipient}`（delivered への回復で解除し、再failで再通知）
const failureStreaks = new Map() // `${seq}:${recipient}` -> 連続失敗数
async function notifyParentOfFailure(seq, recipient, result, reason) {
  if (!parentName) return
  const key = `${seq}:${recipient}`
  if (result === 'delivered') {
    if (notifiedFailures.delete(key)) saveDeliveryState()
    failureStreaks.delete(key)
    return
  }
  // not_a_delivery_target は「そもそもTUI配達対象でない」平常応答であって失敗ではない
  if (reason === 'not_a_delivery_target') return
  // 1回目の失敗は通知しない。数秒後の再試行で自己回復する一過性（paste競合等）が
  // 毎回親を起こしてノイズになった（実被弾 2026-08-30）。実害のある失敗は次周期で
  // 2回目に達するので、検知は数秒遅れるだけで漏れない。
  const streak = (failureStreaks.get(key) ?? 0) + 1
  failureStreaks.set(key, streak)
  if (streak < 2) return
  if (notifiedFailures.has(key)) return
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/messages`, {
      method: 'POST', headers: writeHeaders,
      body: JSON.stringify({
        from: 'wakeup', to: parentName,
        body: `[配達失敗] seq=${seq} 宛先=${recipient} 状態=${result}${reason ? ` 理由=${reason}` : ''}。台帳とwakeup-bridge.logを確認し、席の復旧または再送を判断すること`,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    notifiedFailures.add(key)
    saveDeliveryState()
  } catch (error) {
    log(`DELIVERY_FAILURE_NOTIFY_FAILED ${JSON.stringify({ seq, recipient, detail: error.message.split('\n')[0] })}`)
  }
}
async function postReceipt(seq, recipient, result, reason = null) {
  await notifyParentOfFailure(seq, recipient, result, reason)
  if (receiptSupported === false) return
  const key = `${seq}:${recipient}`
  const value = `${result}:${reason ?? ''}`
  if (postedReceipts.get(key) === value) return
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/deliveries`, {
      method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ seq, recipient, result, ...(reason ? { reason } : {}) }),
    })
    if (res.status === 404) {
      receiptSupported = false
      log('server が配送 receipt 台帳を持たない版（404）。receipt 送信を止める')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    postedReceipts.set(key, value)
  } catch (error) {
    log(`DELIVERY_RECEIPT_WRITE_FAILED ${JSON.stringify({ seq, recipient, result, detail: error.message.split('\n')[0] })}`)
  }
}
beatBridge()
setInterval(beatBridge, 5_000) // 送信自体は BEAT_MS で間引く。失敗した心拍を次の周期で取り返すための駆動

// 席ごとに未配達を溜めて、2秒ごとにまとめて1回起こす（連投で席を何度も起こさない）。
// pending は room message の宛先名から作る。起動引数や harness は候補集合を決めない。
const pending = new Map() // name -> Map<seq, message>
const stuckStreaks = new Map() // name -> { key: 'seq,seq', code, count }（連続失敗数。STUCK=5・席不在=150周期で打ち切り）
// 席不在系の打ち切り周期（150周期≈5分）。上書きは experiments の再現 harness が待ち時間短縮に使うだけ
const goneAbandonCycles = Number(process.env.PEERTABLE_GONE_ABANDON_CYCLES) > 0
  ? Number(process.env.PEERTABLE_GONE_ABANDON_CYCLES) : 150
const deliveryStates = new Map() // seq -> { message, targets, delivered }
let seats = []
let members = new Map()
let membersObserved = false
function forgetSeat(seat) {
  const queue = pending.get(seat)
  if (queue) {
    for (const msg of queue.values()) {
      const state = deliveryStates.get(msg.seq)
      if (!state) continue
      state.targets.delete(seat)
    }
  }
  pending.delete(seat)
  advanceLastSeq()
}

function reconcileSeats() {
  const next = new Set()
  if (membersObserved) {
    for (const member of members.values()) {
      if (!isWakeupBridgeTarget(member, targetOpts)) continue
      next.add(member.name)
      if (!pending.has(member.name)) pending.set(member.name, new Map())
    }
  }
  for (const seat of [...pending.keys()]) {
    if (next.has(seat)) continue
    log(`配送対象外の席を外した: ${seat}`)
    forgetSeat(seat)
  }
  const previous = seats.join(',')
  seats = [...next]
  if (previous !== seats.join(',')) log(`監視席を更新: ${seats.join(',') || 'なし'}`)
}
async function refreshMembers() {
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
    if (!res.ok) throw new Error(`members ${res.status}`)
    const body = await res.json()
    if (!Array.isArray(body.members)) throw new Error('members response is not an array')
    members = new Map(body.members.map(member => [member.name, member]))
    membersObserved = true
    reconcileSeats()
    return true
  } catch (error) {
    // 直前の member map は保持するが、起動引数や既定 socketへ縮退しない。
    log(`member 記述子を更新できないので直前の観測を保持する: ${error.message}`)
    return false
  }
}
reconcileSeats()
await refreshMembers()
function markReady() {
  const current = readRecord() || {}
  writeRecord({
    ...current,
    ready_at: new Date().toISOString(),
    last_progress_at: new Date().toISOString(),
  })
}

function loadDeliveryState() {
  try {
    const saved = JSON.parse(readFileSync(deliveryStatePath, 'utf8'))
    if (saved.room !== room || saved.server_url !== url) return { primed: false, lastSeq: 0, delivered: new Set(), notified: new Set() }
    return {
      primed: saved.primed === true,
      lastSeq: Number.isSafeInteger(saved.last_seq) && saved.last_seq >= 0 ? saved.last_seq : 0,
      delivered: new Set(Array.isArray(saved.delivered) ? saved.delivered.filter(key => typeof key === 'string') : []),
      notified: new Set(Array.isArray(saved.notified) ? saved.notified.filter(key => typeof key === 'string') : []),
    }
  } catch {
    return { primed: false, lastSeq: 0, delivered: new Set(), notified: new Set() }
  }
}

const deliveryState = loadDeliveryState()
let lastSeq = deliveryState.lastSeq
const delivered = deliveryState.delivered
let primed = deliveryState.primed
// 通知済み集合を耐再起動にする。メモリだけだと bridge が再起動するたび同じ [配達失敗] DM を
// room へ再投稿する（2026-08-30 実測: 13回の再起動で同一通知が13重複し、公開feedの末尾78件が
// 全部配達失敗になった）
for (const key of deliveryState.notified) notifiedFailures.add(key)
function saveDeliveryState() {
  const temp = `${deliveryStatePath}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({
    room,
    server_url: url,
    primed,
    last_seq: lastSeq,
    delivered: [...delivered].slice(-10_000),
    notified: [...notifiedFailures].slice(-10_000),
  }) + '\n')
  renameSync(temp, deliveryStatePath)
}

function deliveryKey(seq, seat) {
  return `${seq}:${seat}`
}

function recipientNames(msg) {
  if (Array.isArray(msg.to_names)) {
    if (msg.to_names.includes(BROADCAST_RECIPIENT)) return []
    return [...new Set(msg.to_names.filter(name => typeof name === 'string' && name.length > 0))]
  }
  if (msg.to === BROADCAST_RECIPIENT) return [...members.keys()].filter(name => name !== msg.from)
  if (typeof msg.to === 'string' && msg.to.length > 0 && msg.to !== BROADCAST_RECIPIENT) return [msg.to]
  return []
}

function advanceLastSeq() {
  let advanced = false
  for (;;) {
    const state = deliveryStates.get(lastSeq + 1)
    if (!state) break
    if (![...state.targets].every(seat => state.delivered.has(seat))) break
    deliveryStates.delete(lastSeq + 1)
    lastSeq += 1
    advanced = true
  }
  if (advanced) saveDeliveryState()
}

const deferredBusy = new Set()
async function passKnownCodexDialog(member) {
  if (memberHarness(member) !== 'codex') return false
  if (!isWakeupBridgeTarget(member, targetOpts)) return false
  const observation = resolveSeatObservation(member, null)
  if (observation === null) return false
  const pane = await run('tmux', tmuxArgv(['capture-pane', '-t', observation.target, '-p'], { socket: observation.socket }))
  const dialog = keysForCodexPane(String(pane.stdout ?? ''))
  if (!dialog) return false
  for (const key of dialog.keys) {
    await run('tmux', tmuxArgv(['send-keys', '-t', observation.target, key], { socket: observation.socket }))
    await sleep(150)
  }
  log(`Codex ${dialog.kind} を通した: ${member.name}`)
  return true
}

async function wake(seat, msgs) {
  const last = msgs[msgs.length - 1]
  const text = msgs.map(formatWakeNotice).join(' || ')
  // 配送直前に member ledger を取り直し、current name -> descriptor の一経路だけを使う。
  await refreshMembers()
  const member = members.get(seat)
  if (!isWakeupBridgeTarget(member, targetOpts)) return 'skipped'
  const observation = resolveSeatObservation(member, null)
  if (observation === null) {
    const code = members.has(seat) ? 'DESCRIPTOR_MISSING' : 'MEMBER_MISSING'
    const error = new Error(`${code}: ${seat}`)
    error.code = code
    throw error
  }
  // **席の TUI への打鍵は aiterm の公開 API（pty_send / agent_steer）だけで行う。**
  // PTY の状態（agent が tty の前面か・termios が raw か・貼付の方言・submit の成立）は aiterm が
  // 所有し、bridge は「誰に・いつ・何を届けるか」と receipt だけを持つ（責務境界。2026-09-04
  // オーナー裁定: 0.8.51/0.8.52 で bridge に足した fg／stty は aiterm へ移し、ここからは撤去）。
  // 死んだ席（agent 不在の素の shell）へは aiterm の ready gate が入力受付不能として送らない。
  const pane = await run('tmux', tmuxArgv(['capture-pane', '-t', observation.target, '-p'], { socket: observation.socket }))
  const screen = String(pane.stdout ?? '')
  const harness = memberHarness(member)
  const tail = screen.split('\n').slice(-14).join('\n')
  if (harness === 'grok') {
    if (shouldDeferGrokWake(harness, tail)) {
      if (!deferredBusy.has(seat)) {
        log(`Grok席が実行中なのでidleまで待つ: ${seat} ← ${msgs.length} 件`)
        deferredBusy.add(seat)
      }
      return 'deferred'
    }
    deferredBusy.delete(seat)
  }
  if (await passKnownCodexDialog(member)) return 'deferred'
  const sessionId = typeof member.aiterm_session_id === 'string' && member.aiterm_session_id
    ? member.aiterm_session_id
    : observation.target
  // Codex は実行中ターンへ steer（0.153 は「次の tool call 後に送る」キューへ積む）、idle なら dispatch。
  // 実行中の判定は画面の実行中マーカーだけ（読むだけで、状態を変えない）。
  const busy = classifyPaneTail(tail) === 'busy' || tail.includes('esc to interrupt')
  const deliverScript = fileURLToPath(new URL('./aiterm-deliver.mjs', import.meta.url))
  const deliverFile = join(proj, '.team', `wakeup-deliver-${process.pid}.txt`)
  writeFileSync(deliverFile, text)
  const deliver = async (mode) => {
    const res = await run(process.execPath, [deliverScript, sessionId, deliverFile, `--mode=${mode}`],
      { env: process.env, maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(String(res.stdout || '{}'))
  }
  let mode = harness === 'codex' && busy ? 'steer' : 'dispatch'
  let receipt
  try {
    receipt = await deliver(mode)
    if (receipt?.schema === 'aiterm.agent-steer.v1' && receipt.delivery === 'idle') {
      // steer した瞬間に idle へ落ちた。dispatch で届け直す（aiterm が ready gate を通す）
      mode = 'dispatch'
      receipt = await deliver(mode)
    }
  } catch (e) {
    const detail = String(e?.stderr || e?.message || e).split('\n').filter(Boolean).join(' / ').slice(0, 240)
    if (/入力受付状態になりません|AGENT_TUI_BACKGROUNDED|AGENT_TTY_COOKED/u.test(detail)) {
      // 席は在るが今は受け取れない（実行中・ダイアログ・前面回復不能）。次周期に再試行する
      log(`配達できず次周期に再試行: ${seat} ← ${msgs.length} 件: ${detail}`)
      return 'deferred'
    }
    const error = new Error(`DELIVERY_FAILED: ${seat}: ${detail}`)
    error.code = 'DELIVERY_FAILED'
    throw error
  } finally {
    try { unlinkSync(deliverFile) } catch { /* 一時fileの掃除失敗は配達判定に影響しない */ }
  }
  if (receipt?.submit_residue === true) {
    // aiterm が composer への残存を観測＝submit 未成立の疑い。受領を確定せず次周期に再試行する
    log(`DELIVERY_STUCK: ${seat} の composer に本文が残存（aiterm submit_residue=true）。受領を確定せず次周期に再試行する`)
    const error = new Error(`DELIVERY_STUCK: ${seat}`)
    error.code = 'DELIVERY_STUCK'
    throw error
  }
  const recovered = Array.isArray(receipt?.pane_input_recovery) && receipt.pane_input_recovery.length
    ? `・回復 ${receipt.pane_input_recovery.join(',')}`
    : ''
  log(`TUIへ入れた: ${seat} ← ${msgs.length} 件（最新 seq ${last.seq}・${mode}${recovered}）`)
}

function dispatch(msg) {
  if (deliveryStates.has(msg.seq)) return
  if (isIdleSelfWake(msg)) {
    deliveryStates.set(msg.seq, { message: msg, targets: new Set(), delivered: new Set() })
    advanceLastSeq()
    return
  }
  const targets = recipientNames(msg).filter(seat => isWakeupBridgeTarget(members.get(seat), targetOpts))
  const state = { message: msg, targets: new Set(targets), delivered: new Set() }
  for (const seat of targets) {
    if (delivered.has(deliveryKey(msg.seq, seat))) state.delivered.add(seat)
  }
  deliveryStates.set(msg.seq, state)
  for (const seat of targets) {
    if (state.delivered.has(seat)) continue
    if (!pending.has(seat)) pending.set(seat, new Map())
    pending.get(seat).set(msg.seq, msg)
  }
  advanceLastSeq()
}

const flushing = new Set()
async function flushSeat(seat) {
  if (flushing.has(seat)) return
  const queue = pending.get(seat)
  if (!queue || queue.size === 0) return
  flushing.add(seat)
  let msgs = []
  try {
    // 読了ack照会（2026-08-25）: 席のclientはread_unreadで取得した最終seqを次の自分の投稿へ
    // 相乗り申告し、serverがmember.read_seqへ単調保存する。注入直前に照会し、申告済みseq以下は
    // 再配達しない（席が読んで返答済みの既読群を再注入して起こした実被弾 2026-08-25 poly卓）。
    // 読了直後・投稿前にターンが死んだ席はackが無いので従来どおり再配達される＝安全網は保つ。
    // refreshMembers失敗時は直前観測のread_seqを使う＝古い分は再配達側へ倒れる（安全方向）。
    await refreshMembers()
    const ackedSeq = Number(members.get(seat)?.read_seq ?? 0)
    if (ackedSeq > 0) {
      const acked = [...queue.values()].filter(msg => msg.seq <= ackedSeq)
      if (acked.length > 0) {
        for (const msg of acked) {
          const state = deliveryStates.get(msg.seq)
          if (state) state.delivered.add(seat)
          delivered.add(deliveryKey(msg.seq, seat))
        }
        // durable保存失敗時はin-memory印を巻き戻す（TUI成功経路517–525と同じ契約。反証1）
        try {
          saveDeliveryState()
        } catch (error) {
          for (const msg of acked) {
            deliveryStates.get(msg.seq)?.delivered.delete(seat)
            delivered.delete(deliveryKey(msg.seq, seat))
          }
          throw error
        }
        for (const msg of acked) queue.delete(msg.seq)
        // 席は本文を自分で読了済み。配達保証（決定102）はacked_read理由のdeliveredで満たす
        for (const msg of acked) await postReceipt(msg.seq, seat, 'delivered', 'acked_read')
        log(`既読ackで配達を省略: ${seat} ← ${acked.length} 件（read_seq=${ackedSeq}）`)
        advanceLastSeq()
      }
      if (queue.size === 0) return
    }
    msgs = [...queue.values()].sort((a, b) => a.seq - b.seq)
    const outcome = await wake(seat, msgs)
    if (outcome === 'deferred') return
    if (outcome === 'skipped') {
      for (const msg of msgs) await postReceipt(msg.seq, seat, 'seat_unavailable', 'not_a_delivery_target')
      forgetSeat(seat)
      return
    }
    const receipts = []
    for (const msg of msgs) {
      if (queue.get(msg.seq) !== msg) continue
      const state = deliveryStates.get(msg.seq)
      if (!state) continue
      state.delivered.add(seat)
      delivered.add(deliveryKey(msg.seq, seat))
      receipts.push({ msg, state })
    }
    // lastSeq が先行seqの別宛先失敗で止まっても、今回成功した宛先のreceiptは失わない。
    // durable receiptを先に確定してからpendingを消すので、再起動後に成功席へ重複wakeしない。
    if (receipts.length > 0) {
      try {
        saveDeliveryState()
      } catch (error) {
        for (const { msg, state } of receipts) {
          state.delivered.delete(seat)
          delivered.delete(deliveryKey(msg.seq, seat))
        }
        throw error
      }
      for (const { msg } of receipts) queue.delete(msg.seq)
      // TUI 投入が成立した時にだけ server の配送 receipt を delivered にする（決定102）
      for (const { msg } of receipts) await postReceipt(msg.seq, seat, 'delivered')
    }
    advanceLastSeq()
  } catch (error) {
    // 失敗時はpendingもreceiptもcursorも動かさない。次のmember refreshで
    // descriptor/PTYが復旧した時、同じseqを同じ宛先へ一度だけ再試行する。
    const code = typeof error.code === 'string' ? error.code : 'INJECTION_FAILED'
    log(`WAKEUP_BRIDGE_DELIVERY_FAILURE ${JSON.stringify({
      recipient: seat,
      code,
      seqs: msgs.map(msg => msg.seq),
      detail: error.message.split('\n')[0],
    })}`)
    // 席不在系は seat_unavailable、それ以外は failed として server へ現況を残す。
    // 再試行が成立すれば同じ (seq, recipient) を delivered で上書きする
    const result = ['SEAT_TUI_GONE', 'MEMBER_MISSING', 'DESCRIPTOR_MISSING'].includes(code) ? 'seat_unavailable' : 'failed'
    for (const msg of msgs) await postReceipt(msg.seq, seat, result, code)
    // 同一集合の失敗が続いたら再試行を打ち切る。STUCK は5周期（composer汚染を止める）、
    // 席不在系は150周期≈5分（席の再起動・立て直しは待ち、卓ごと死んだ席だけを見切る）。
    // 打ち切りは delivered 台帳へ耐再起動で記録する——記録しないと lastSeq が前進せず、
    // bridge の再起動ごとに同じ seq の再試行が蘇る（2026-08-30 実測: 席全滅の卓で
    // seq 2件が18時間・3.7万行の SEAT_TUI_GONE を刻み続けた）。failed receipt と
    // 親宛[配達失敗]DMは既に出ており、無限再試行は誰も救わない。
    const abandonAfter = code === 'DELIVERY_STUCK' ? 5
      : ['SEAT_TUI_GONE', 'MEMBER_MISSING', 'DESCRIPTOR_MISSING'].includes(code) ? goneAbandonCycles
      : null
    if (abandonAfter !== null) {
      const key = msgs.map((msg) => msg.seq).join(',')
      const prev = stuckStreaks.get(seat)
      const count = prev?.key === key && prev.code === code ? prev.count + 1 : 1
      stuckStreaks.set(seat, { key, code, count })
      if (count >= abandonAfter) {
        const queue = pending.get(seat)
        for (const msg of msgs) {
          if (queue) queue.delete(msg.seq)
          deliveryStates.get(msg.seq)?.delivered.add(seat)
          delivered.add(deliveryKey(msg.seq, seat))
        }
        stuckStreaks.delete(seat)
        saveDeliveryState()
        advanceLastSeq()
        log(`DELIVERY_ABANDONED: ${seat} への seq ${key} は${count}周期連続${code}のため再試行を打ち切る（receipt=${result}・親へ通知済み・再起動後も再試行しない）`)
      }
    } else {
      stuckStreaks.delete(seat)
    }
  } finally {
    flushing.delete(seat)
  }
}

setInterval(() => {
  for (const [seat, queue] of pending) {
    if (queue.size > 0) flushSeat(seat).catch(error => log(`WAKEUP_BRIDGE_FLUSH_FAILED: ${error.message}`))
  }
}, 2000)

// CodexのMCP/command approvalはroom発言の配達時だけでなく、席自身の最初のtool実行でも
// 遅れて現れる。pending DMが無い時も既知dialogだけを処理し続け、ランプがblockedのまま
// 放置される状態を作らない。未知dialogはkeysForCodexPaneがnullを返すため触らない。
let dialogSweepRunning = false
setInterval(async () => {
  if (dialogSweepRunning) return
  dialogSweepRunning = true
  try {
    for (const member of members.values()) {
      if (member.status_effective === 'dead') continue
      try { await passKnownCodexDialog(member) } catch (error) {
        log(`CODEX_DIALOG_SWEEP_FAILED: ${member.name} ${error.message}`)
      }
    }
  } finally {
    dialogSweepRunning = false
  }
}, 2000)

// 再接続で取りこぼさないために、全宛先の成功が揃った最大 seq を持つ。
// 失敗した宛先がある限り lastSeq は前進せず、GET since から同じseqを回収する。
let dispatchQueue = Promise.resolve()
function dispatchNew(msg) {
  // 心拍由来のcatch-upとSSE本文は同時に到着しうる。refreshMembers() の await より
  // 前でseqを判定すると、同じmsgが両方の経路から二重に積まれ、lastSeqも逆行する。
  // 判定・members同期・カーソル更新・dispatchを一本の順序へ直列化する。
  const queued = dispatchQueue.then(async () => {
    // seq の無いイベントで lastSeq を汚さない。`undefined <= 数値` は false なので、
    // 素通しにすると lastSeq が undefined に化け、取りこぼし回収が静かに壊れる。
    if (typeof msg.seq !== 'number') {
      log(`seq を持たないイベントを捨てた: ${JSON.stringify(msg).slice(0, 120)}`)
      return
    }
    if (msg.seq <= lastSeq) return
    // SSEのmessageだけでは席追加と競合する。DMを積む直前にmembersを取り直し、
    // 配送時にはさらにdescriptorを解決する。refresh失敗でも静的席へ縮退しない。
    await refreshMembers()
    if (msg.seq <= lastSeq || deliveryStates.has(msg.seq)) return
    dispatch(msg)
  })
  dispatchQueue = queued.catch(() => {})
  return queued
}

// 繋がったまま黙って死ぬ接続を検出する。SSE は無音でも生きていられるので、
// 「切れた」ではなく「一定時間なにも届かない」を異常として扱い、自分から切って繋ぎ直す。
// 直後に since で追いつくので、無音が正常だった場合も取りこぼしは出ない。
// server の心拍が 25 秒周期（`room/server.mjs` の HEARTBEAT_MS）なので、その3倍を無音の閾値にする。
const IDLE_MS = 75_000

// 起動直後の1回だけは配達しない。既に流れ終わった過去ログで席を起こしても意味がなく、
// 卓が長いほど巨大な起床通知になる。初回は「ここまでは読んだこと」にして頭出しするだけ。
let catching = false
async function catchUp(reason) {
  // 再接続直後と心拍由来の回収が重なると二重に取りにいく。取りこぼし回収は1本だけ走らせる
  if (catching) return
  catching = true
  try {
    const res = await fetch(`${url}/api/${room}/messages?since=${lastSeq}`)
    if (!res.ok) throw new Error(`messages ${res.status}`)
    const { messages } = await res.json()
    if (!primed) {
      primed = true
      if (messages.length > 0) lastSeq = messages[messages.length - 1].seq
      saveDeliveryState()
      log(`頭出し: seq ${lastSeq} まで既読として開始する`)
      return
    }
    log(`取りこぼし確認（${reason}・since ${lastSeq}）: ${messages.length} 件`)
    for (const msg of messages) await dispatchNew(msg)
  } finally {
    catching = false
  }
}

// 心拍の data は room の最新 seq である（kotoha の `859bc21`）。これが自分の lastSeq より
// 進んでいたら「繋がったままなのに取りこぼしている」証拠になる。**watchdog はこの穴を原理的に
// 見つけられない**——心拍が届き続ける限り最終受信時刻は更新され続けるので、途絶判定に一生
// 引っかからない。だから常時流れてくる心拍そのものを取りこぼし検出に使う。
function onHeartbeat(dataLine) {
  const head = Number(dataLine)
  if (!Number.isFinite(head) || head <= lastSeq) return
  log(`心拍が示す最新 seq ${head} に追いついていない（手元 ${lastSeq}）`)
  catchUp('心拍の差分').catch(error => log(`心拍由来の回収に失敗: ${error.message}`))
}

let failures = 0
log(`bridge start: room=${room} seats=${seats.join(',')} pid=${process.pid}`)
for (;;) {
  try {
    const abort = new AbortController()
    let lastByteAt = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > IDLE_MS) {
        log(`受信途絶 ${Math.round(IDLE_MS / 1000)} 秒。接続が黙って死んだとみなして繋ぎ直す`)
        abort.abort()
      }
    }, 5000)
    try {
      const res = await fetch(`${url}/api/${room}/events`, { signal: abort.signal })
      if (!res.ok) throw new Error(`events ${res.status}`)
      failures = 0
      log('SSE 接続')
      markReady()
      await catchUp('再接続')
      let buf = ''
      for await (const chunk of res.body) {
        lastByteAt = Date.now()
        touchProgress()
        buf += Buffer.from(chunk).toString('utf8')
        const parts = buf.split('\n\n')
        buf = parts.pop()
        for (const part of parts) {
          const lines = part.split('\n')
          // SSE の1フレームは `event:` と `data:` の複数行で来る。名前付きイベント
          // （server の心拍 `event: ping` / `data: 1` 等）は発言ではないので配達しない。
          // `data:` だけ拾う実装だと心拍の `1` が発言として流れ込む（kotoha [106] の指摘）
          const name = lines.find(l => l.startsWith('event: '))?.slice(7).trim()
          const line = lines.find(l => l.startsWith('data: '))
          if (name === 'ping') { if (line) onHeartbeat(line.slice(6)); continue }
          if (name !== undefined && name !== 'message') continue
          if (line) await dispatchNew(JSON.parse(line.slice(6)))
        }
      }
      log('SSE 切断（再接続する）')
    } finally {
      clearInterval(watchdog)
    }
  } catch (error) {
    // 自分で切った時（watchdog の abort）は失敗ではない——数えると健全な再接続で落ちてしまう
    if (error.name === 'AbortError') {
      log('再接続する')
    } else {
      failures++
      log(`SSE 失敗 ${failures} 回目: ${error.message}`)
      // 落ちっぱなしを黙って再試行し続けない。連続失敗が続いたら記録を外して落ちる
      if (failures >= 10) {
        console.error('WAKEUP_BRIDGE_UNREACHABLE: room の SSE へ10回連続で繋げない')
        if (existsSync(record)) unlinkSync(record)
        process.exit(1)
      }
    }
  }
  await sleep(2000)
}
