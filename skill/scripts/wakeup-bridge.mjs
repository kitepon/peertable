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
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolvePostToken, resolveSeatObservation, tmuxArgv } from './seat-usage.mjs'
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
async function postReceipt(seq, recipient, result, reason = null) {
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
    if (saved.room !== room || saved.server_url !== url) return { primed: false, lastSeq: 0, delivered: new Set() }
    return {
      primed: saved.primed === true,
      lastSeq: Number.isSafeInteger(saved.last_seq) && saved.last_seq >= 0 ? saved.last_seq : 0,
      delivered: new Set(Array.isArray(saved.delivered) ? saved.delivered.filter(key => typeof key === 'string') : []),
    }
  } catch {
    return { primed: false, lastSeq: 0, delivered: new Set() }
  }
}

const deliveryState = loadDeliveryState()
let lastSeq = deliveryState.lastSeq
const delivered = deliveryState.delivered
let primed = deliveryState.primed
function saveDeliveryState() {
  const temp = `${deliveryStatePath}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({
    room,
    server_url: url,
    primed,
    last_seq: lastSeq,
    delivered: [...delivered].slice(-10_000),
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
  // **agent CLI が死んで pane が素の shell に戻っていたら、1バイトも打たない。**
  // shell へ room の本文を send-keys すると、本文がそのまま shell コマンドとして実行される
  // （実被弾 2026-08-22: codex 終了後の bash へ配達され `command not found` が走った。
  // 本文次第では席の権限で任意コマンドになる）。配達は止め、毎周期 typed log で叫ぶ。
  // **pane_current_command は「bash の下で agent CLI が走る」形を bash と報告することがある**
  // （実被弾 2026-08-22: 生きている codex 席が bash 判定になり配達が全停止、席が起きなかった）。
  // shell 名だった時だけ pane 配下の生きた子孫を数え、**子孫ゼロの素の shell** だけを遮断する。
  // agent CLI が死ねば子孫も消えるので、塞ぎたい穴（room 本文の shell 実行）はこの条件で塞がる。
  const fg = await run('tmux', tmuxArgv(['display-message', '-p', '-t', observation.target, '#{pane_current_command}'], { socket: observation.socket }))
  const fgCommand = String(fg.stdout ?? '').trim()
  if (['bash', 'zsh', 'sh', 'dash', 'fish', 'tcsh', 'csh', 'ksh'].includes(fgCommand)) {
    const panePidOut = await run('tmux', tmuxArgv(['display-message', '-p', '-t', observation.target, '#{pane_pid}'], { socket: observation.socket }))
    const panePid = Number(String(panePidOut.stdout ?? '').trim())
    let descendants = 0
    if (Number.isSafeInteger(panePid) && panePid > 0) {
      const psOut = await run('/bin/ps', ['-axo', 'pid=,ppid='], { env: { ...process.env, LC_ALL: 'C' } })
      const children = new Map()
      for (const line of String(psOut.stdout ?? '').split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/u).map(Number)
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
        if (!children.has(ppid)) children.set(ppid, [])
        children.get(ppid).push(pid)
      }
      const queue = [...(children.get(panePid) ?? [])]
      while (queue.length) {
        const pid = queue.pop()
        descendants += 1
        queue.push(...(children.get(pid) ?? []))
      }
    }
    if (descendants === 0) {
      log(`SEAT_TUI_GONE: ${seat} の pane は子孫プロセスの無い素の shell（${fgCommand}）＝agent CLI が終了済み。`
        + 'shell へのコマンド実行を防ぐため配達しない。席を立て直すか leave-seat で畳むこと')
      const error = new Error(`SEAT_TUI_GONE: ${seat}`)
      error.code = 'SEAT_TUI_GONE'
      throw error
    }
  }
  const pane = await run('tmux', tmuxArgv(['capture-pane', '-t', observation.target, '-p'], { socket: observation.socket }))
  const screen = String(pane.stdout ?? '')
  if (memberHarness(member) === 'codex') {
    const dialog = keysForCodexPane(screen)
    if (dialog) {
      for (const key of dialog.keys) {
        await run('tmux', tmuxArgv(['send-keys', '-t', observation.target, key], { socket: observation.socket }))
      }
      log(`Codex ${dialog.kind} を通した: ${seat}`)
      return 'deferred'
    }
  }
  if (memberHarness(member) === 'grok') {
    const tail = screen.split('\n').slice(-14).join('\n')
    if (shouldDeferGrokWake(memberHarness(member), tail)) {
      if (!deferredBusy.has(seat)) {
        log(`Grok席が実行中なのでidleまで待つ: ${seat} ← ${msgs.length} 件`)
        deferredBusy.add(seat)
      }
      return 'deferred'
    }
    deferredBusy.delete(seat)
  }
  // Codexの入力欄は本文とEnterを同じtmux commandで送ると、初回turn完了後に
  // 本文が入力欄へ残ることがある。再試行時の半入力も含め、正規のsubmitを分離する。
  // 最後のEnterまで成功しない限りwakeは成功扱いにせず、flushSeatのreceiptも確定しない。
  await run('tmux', tmuxArgv(['send-keys', '-t', observation.target, 'C-u'], { socket: observation.socket }))
  await sleep(100)
  await run('tmux', tmuxArgv(['send-keys', '-l', '-t', observation.target, text], { socket: observation.socket }))
  await sleep(750)
  await run('tmux', tmuxArgv(['send-keys', '-t', observation.target, 'Enter'], { socket: observation.socket }))
  // 送信検証。Codex v0.148 は長文入力後に「Create a plan?」popup が出て Enter を呑むことがあり、
  // 本文が入力欄に残ったまま席が沈黙する（2026-08-22 実測: 2席が無音停止し、人が画面を見るまで
  // 誰も気づけなかった）。打鍵成功＝配達成功とみなさず、画面で送信成立を確認する。
  // 残っていれば Escape（popup解除）→ Enter で再送信し、それでも残るなら受領を確定せず
  // 次周期に再試行する（毎回ログに残るので沈黙しない）。
  const markerSource = text.replace(/\s+/gu, '')
  const marker = markerSource.slice(-24)
  // Claude Code は長文入力を折り畳んで本文を画面から消し（"paste again to expand" /
  // "[Pasted text"）、ターン実行中は "esc to interrupt" でなくスピナー（✻✽·）を出す。
  // この2つで旧検証は「未送信」と誤判定し、しかも回復に撃つ Escape が **Claude の実行中
  // ターンを中断**していた（実被弾 2026-08-22: 監査席が2秒ごとに中断され、監査が進まなかった）。
  // Claude 席は「受理された兆候」を成功とみなし、回復キーに Escape を使わない。
  const CLAUDE_ACCEPTED = /paste again to expand|\[Pasted text|esc to interrupt|✻|✽|✳|·\s*\w+ing…/u
  const isClaude = memberHarness(member) === 'claude'
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1200)
    const after = await run('tmux', tmuxArgv(['capture-pane', '-t', observation.target, '-p'], { socket: observation.socket }))
    const tailLines = String(after.stdout ?? '').split('\n').slice(-14)
    const tailJoined = tailLines.join(' ')
    // 折返しはcapture上で行分割されるだけで空白は挟まらないため、空白除去で復元して照合する
    const tailSquashed = tailLines.join('').replace(/\s+/gu, '')
    const queuedOrRunning = tailJoined.includes('esc to interrupt') || tailJoined.includes('to queue message')
      || (isClaude && CLAUDE_ACCEPTED.test(tailJoined))
    const stuck = (!isClaude && tailJoined.includes('esc dismiss'))
      || (marker.length >= 8 && tailSquashed.includes(marker) && !queuedOrRunning)
    if (!stuck) break
    if (attempt === 2) {
      log(`DELIVERY_STUCK: ${seat} の入力欄に本文が残ったまま送信できない（popup／入力詰まり）。受領を確定せず次周期に再試行する`)
      const error = new Error(`DELIVERY_STUCK: ${seat}`)
      error.code = 'DELIVERY_STUCK'
      throw error
    }
    if (isClaude) {
      // Escape は撃たない（実行中ターンを殺す）。Enter だけ打ち直す
      log(`配達が送信されていない: ${seat}（Claude 席のため Escape は使わず Enter を打ち直す）`)
      await run('tmux', tmuxArgv(['send-keys', '-t', observation.target, 'Enter'], { socket: observation.socket }))
      continue
    }
    log(`配達が送信されていない（popup／入力詰まり）: ${seat}。Escape→Enter で再送信する`)
    await run('tmux', tmuxArgv(['send-keys', '-t', observation.target, 'Escape'], { socket: observation.socket }))
    await sleep(300)
    await run('tmux', tmuxArgv(['send-keys', '-t', observation.target, 'Enter'], { socket: observation.socket }))
  }
  log(`TUIへ入れた: ${seat} ← ${msgs.length} 件（最新 seq ${last.seq}）`)
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
  const msgs = [...queue.values()].sort((a, b) => a.seq - b.seq)
  try {
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
  } finally {
    flushing.delete(seat)
  }
}

setInterval(() => {
  for (const [seat, queue] of pending) {
    if (queue.size > 0) flushSeat(seat).catch(error => log(`WAKEUP_BRIDGE_FLUSH_FAILED: ${error.message}`))
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
