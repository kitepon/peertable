#!/usr/bin/env node
import { parentRecipients } from '../../room/parent-kind.mjs'
// Aitermの公開観測をroomの稼働表示と継続番犬へつなぐ。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { STOP_DECLARATION, patrolTargets, decideBridgeContinuation, resolveLatticeExecutable, resolvePostToken, supportsMemberObservation } from './seat-usage.mjs'
import { AitermClient } from './aiterm-client.mjs'
import { SeatObserver } from './seat-observer.mjs'
import { updateBridgeProgress } from './bridge-record-live.mjs'

const args = process.argv.slice(2)
const proj = args[0]
if (!proj) { console.error('usage: seat-status-bridge.mjs <project_dir> [--interval <sec>] [--once] | --stop'); process.exit(1) }
const stop = args.includes('--stop')
const once = args.includes('--once')
const interval = Number(args[args.indexOf('--interval') + 1]) || 8
const HEARTBEAT_MS = 30_000 // 変化が無くても最低この間隔で送る（server 側の減衰より短いこと）

const stateDir = join(proj, '.team')
const pidPath = join(stateDir, 'seat-status-bridge.json')
const setupPath = join(stateDir, 'setup-state.json')

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// ADR 0157 の作法: pid を記録し、起動時に死んだ記録を掃除し、--stop で明示停止する
if (stop) {
  if (!existsSync(pidPath)) { console.error('seat-status-bridge: 起動記録が無い（既に停止）'); process.exit(0) }
  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8'))
  if (alive(pid)) {
    // SIGTERM 5秒 → SIGKILL 3秒（wakeup-bridge.mjs と同じ形）。**昇格が無いと、SIGTERM を無視する
    // 常駐が居た時に teardown が `set -e` の2段目で即死して、[未実施] も [手当] も要約も出ない**
    process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
      for (let i = 0; i < 30 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (alive(pid)) { console.error(`SEAT_STATUS_BRIDGE_STOP_FAILED: pid ${pid} が SIGKILL でも止まらない`); process.exit(1) }
  }
  // 止めた側の SIGTERM handler が先に消していることがある。生の traceback を出さない（それ自体が
  // 「何が起きたか分からない失敗」になる——今日 teardown で同じ形を叩いたばかり）
  try { unlinkSync(pidPath) } catch { /* 既に消えている＝目的は達成されている */ }
  console.error(`seat-status-bridge: 停止した（pid ${pid}）`)
  process.exit(0)
}

if (existsSync(pidPath)) {
  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8'))
  if (alive(pid)) { console.error(`seat-status-bridge: 既に動いている（pid ${pid}）`); process.exit(1) }
  unlinkSync(pidPath) // 死んだ記録は掃除する
}

const setup = JSON.parse(readFileSync(setupPath, 'utf8'))
const url = setup.server_url
const room = setup.room
// launch-seat.sh:25-27 と同じ解決規則（env が先・無ければ `~/.config/peertable.env`）。
// **起こす側の shell の env に依存しない**——依存していた時、`export` 欠落だけで常駐が丸ごと死んだ
const token = resolvePostToken(process.env)
writeFileSync(pidPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n')

const aiterm = new AitermClient()
const observer = new SeatObserver(aiterm, room)
let readyRecorded = false

async function seats() {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).members
}

async function send(name, observation, observedAt) {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) },
    body: JSON.stringify({
      name,
      status: observation.status,
      status_at: observedAt,
      busy_since: observation.busySince,
      pane_token_hint: observation.paneTokenHint,
      usage_source: 'pane_status',
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// 200 を保存の証拠にしない（haruka の t14 と同じ判断）。現行 server は知らない欄を黙って捨てて 200 を返すので、
// 読み返して実際に載ったかを見る。載らない版なら、そう言って**黙って成功したふりをしない**
async function serverKeepsStatus() {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
  return supportsMemberObservation(await res.json())
}

// ---- 継続番犬（2026-08-22 オーナー設計）----
// 「AI は ToDo が終わっていなくてもターンを終えてしまう」への機械保証。busy が一定時間
// 続いた席が停止宣言（[待機]/[監査提出]等）なしに idle 化したら、継続指示を配達する。
// 自己DM（席の自己規律）は保険として残るが、継続の保証はこの番犬が持つ。
// busy 2分未満は情報読取だけの正当な無宣言ターンがあるため起こさない（誤爆の代償は
// 待機宣言1ターンで、宣言後の episode は declared 判定で再起こしされない）。
const NUDGE_MIN_BUSY_MS = 120_000
const nudgedEpisodes = new Map() // name -> busySince（同一エピソード1回だけ）
async function nudgeIfDropped(name, busySince) {
  if (!busySince || nudgedEpisodes.get(name) === busySince) return
  if (Date.now() - Date.parse(busySince) < NUDGE_MIN_BUSY_MS) return
  nudgedEpisodes.set(name, busySince)
  let messages
  try {
    messages = (await (await fetch(`${url}/api/${encodeURIComponent(room)}/messages`)).json()).messages ?? []
  } catch { return }
  const since = Date.parse(busySince)
  if (messages.some(m => m.from === name && Date.parse(m.ts) >= since && STOP_DECLARATION.test(m.body ?? ''))) return
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) },
      body: JSON.stringify({ from: 'alarm', to: name,
        body: '[継続] 停止宣言なしにターンが終了した。未完の作業があれば続行すること。手番が無いなら規約どおり [待機] を宣言してから沈黙すること。' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    console.error(`seat-status-bridge: 継続番犬が ${name} を起こした（停止宣言なしの busy→idle）`)
  } catch (e) {
    console.error(`seat-status-bridge: 継続番犬の起こしに失敗: ${e.message}`)
  }
}

// ---- claim巡回番犬（2026-08-25 オーナー設計）----
// 「activeなclaimを保有する席が、有効な待機宣言なしにidleでいる」ことを**周期的に**検査して起こす。
// 上のbusy→idle遷移番犬は2分未満のターンで作業を落とした席を構造的に見ない（実被弾 2026-08-25:
// 目覚ましで起床→1分未満で「再開します」と宣言だけしてidle化。以後どの装置も起こさなかった）。
// 待機宣言の有効性: 宣言より後にその席宛の名指しメッセージ（目覚まし・DM）が届いたら失効。
// 目覚ましで起こされた席の古い宣言文面を、寝ている根拠にしない（同実被弾: #105宣言→#106起床→就寝）。
// to:"all" は失効させない——親の待機宣言運用（起きても返信不要）と両立させるため。
const PATROL_INTERVAL_MS = 30_000
const PATROL_NAG_INTERVAL_MS = 300_000 // 条件が続く席へは5分間隔で再吠えする（1回きりにしない）
// 通報先はroomの現在の親delivery.kindから解決する。
const PATROL_ESCALATE_AFTER = 3 // 連続催促がこの回数に達したら親へ縮退疑いを1回通報する
const patrolLastNag = new Map() // seat -> epoch_ms
const patrolNagStreak = new Map() // seat -> 連続催促数（催促条件が消えたらリセット）
const patrolEscalated = new Set() // 同一縮退エピソードでの親通報は1回だけ
const busyStartedAt = new Map() // seat -> epoch_ms（このbridgeプロセスが観測した最後のターン開始・pane基準）
const paneLast = new Map() // seat -> 直前周期のpane生status（番犬系専用。表示合成とは分離）
let lastPatrolAt = 0
async function patrolClaims() {
  if (setup.mode !== 'lattice' || !setup.plan_key) return
  const now = Date.now()
  if (now - lastPatrolAt < PATROL_INTERVAL_MS) return
  lastPatrolAt = now
  let activeTasks
  try {
    // doctor.sh と同じ解決規則（LATTICE_CLI env → setup記録 → 既定 'lattice'、Windowsは .cmd 解決）
    const latticeCli = process.env.LATTICE_CLI || (typeof setup.lattice_cli === 'string' && setup.lattice_cli) || 'lattice'
    const lattice = resolveLatticeExecutable(latticeCli)
    const out = execFileSync(lattice.command, lattice.argv, { cwd: proj, encoding: 'utf8' })
    activeTasks = (JSON.parse(out).active_set ?? []).map(t => t.task_id)
  } catch (e) {
    console.error(`seat-status-bridge: claim巡回がLatticeを読めない（今周期は検査しない）: ${e.message.split('\n')[0]}`)
    return
  }
  if (!activeTasks.length) return
  let messages
  try {
    messages = (await (await fetch(`${url}/api/${encodeURIComponent(room)}/messages`)).json()).messages ?? []
  } catch { return }
  const targets = patrolTargets({
    activeTasks, messages, statusOf: seat => last.get(seat)?.status ?? null,
    lastBusyStartAt: seat => busyStartedAt.get(seat) ?? null,
    now, lastNag: patrolLastNag, nagIntervalMs: PATROL_NAG_INTERVAL_MS,
  })
  // 催促対象から外れた席は縮退エピソード終了とみなし、計数と通報記録を消す
  const targetSeats = new Set(targets.map(t => t.seat))
  for (const seat of [...patrolNagStreak.keys()]) {
    if (!targetSeats.has(seat)) { patrolNagStreak.delete(seat); patrolEscalated.delete(seat) }
  }
  for (const { seat, task } of targets) {
    patrolLastNag.set(seat, now)
    const streak = (patrolNagStreak.get(seat) ?? 0) + 1
    patrolNagStreak.set(seat, streak)
    // 催促に空返事を続ける縮退（実被弾 2026-08-30: 「作業を続けます」と返すだけの席へ
    // 1時間催促を繰り返し、誰にも知られず空転した）。3回で親へ1回だけ通報する。
    // 親宛DMはparent-watchが即時に親を起こす
    if (streak >= PATROL_ESCALATE_AFTER && !patrolEscalated.has(seat)) {
      try {
        const response = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
        if (!response.ok) throw new Error(`members HTTP ${response.status}`)
        const parents = parentRecipients((await response.json()).members)
        if (!parents.length) throw new Error("PARENT_RECIPIENT_MISSING")
        const posted = await fetch(`${url}/api/${encodeURIComponent(room)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) },
          body: JSON.stringify({ from: 'alarm', to: parents.length === 1 ? parents[0] : parents,
            body: `[縮退疑い] ${seat} は工程 ${task} を保有したまま、継続催促${streak}回に停止宣言も進捗も返していない。空返事ループの可能性が高い。席の再起動を検討すること` }),
        })
        if (!posted.ok) throw new Error(`縮退通報 HTTP ${posted.status}`)
        patrolEscalated.add(seat)
        console.error(`seat-status-bridge: 縮退疑いを親へ通報した（${seat} / ${task} / 催促${streak}回）`)
      } catch (e) {
        console.error(`seat-status-bridge: 縮退通報に失敗: ${e.message}`)
      }
    }
    try {
      const res = await fetch(`${url}/api/${encodeURIComponent(room)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) },
        body: JSON.stringify({ from: 'alarm', to: seat,
          body: `[継続] あなたがclaim中の工程 ${task} が着手中のまま、ターン終了後の待機宣言なしに席が停止している。作業を続行するか、外部待ちなら目覚まし条件を登録して [待機] を宣言してから終えること。` }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      console.error(`seat-status-bridge: claim巡回が ${seat} を起こした（${task} を保有したまま無宣言idle）`)
    } catch (e) {
      patrolLastNag.delete(seat)
      console.error(`seat-status-bridge: claim巡回の起こしに失敗: ${e.message}`)
    }
  }
}

// bridge 心拍（決定103）。server の bridge 台帳へ 30 秒ごとに送る。途絶＝status_bridge_down、
// 403＝server 側が bridge_auth_failed として観測する。旧 server（404）へは送り続けない
let lastBridgeBeatAt = 0
let bridgeBeatSupported = null
async function beatBridge() {
  const now = Date.now()
  if (bridgeBeatSupported === false || now - lastBridgeBeatAt < HEARTBEAT_MS) return
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/bridges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) },
      body: JSON.stringify({ kind: 'seat_status', pid: process.pid, state: 'running' }),
    })
    if (res.status === 404) {
      bridgeBeatSupported = false
      console.error('seat-status-bridge: server が bridge 台帳を持たない版（404）。心拍送信を止める')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    bridgeBeatSupported = true
    lastBridgeBeatAt = now
  } catch (e) {
    console.error(`seat-status-bridge: bridge心拍の送信に失敗: ${e.message}`)
  }
}

const last = new Map()   // name -> { status, at }
let supported = null     // server が status を保持する版か（未判定は null）
const tokenBucket = value => value === null ? null : Math.floor(value / 1_000)

// 送信の結果を数えて返す。**呼び出し側が「1件も届いていない」を判定できる形にする**——
// 数えないと、失敗を1行ずつ吐きながら永久に常駐する（2026-08-10 に4時間そうなった）
const NOTHING_ATTEMPTED = { attempted: 0, failed: 0 }

function recordReady() {
  if (readyRecorded) return
  readyRecorded = true
  const record = JSON.parse(readFileSync(pidPath, 'utf8'))
  const temporary = `${pidPath}.${process.pid}.tmp`
  const readyAt = new Date().toISOString()
  writeFileSync(temporary, JSON.stringify({ ...record, ready_at: readyAt, last_progress_at: readyAt }) + '\n')
  renameSync(temporary, pidPath)
}

async function tick() {
  let members
  try { members = await seats() } catch (e) { console.error(`seat-status-bridge: members を読めない: ${e.message}`); return NOTHING_ATTEMPTED }
  // **送る前に、server が status を持つ版かを確かめる。**
  // 現行の `POST /members` は、既存メンバーでも `<名前> が参加した` を必ず room へ流す（`post()` が
  // `if (!members.has(name))` の外にある）。status を保持しない版へ投げると、**保存されないうえに
  // 席全員を起こす system 発言を撒く**——2026-08-08 に私がこれで6件撒いて全席を1ターン起こした。
  // 保持する版かどうかは GET で分かるので、**分かるまで投げない**。
  if (supported === null) {
    try { supported = await serverKeepsStatus() } catch { return NOTHING_ATTEMPTED }   // 判定できない間は送らない
    if (!supported) console.error('seat-status-bridge: この room サーバーは稼働状態を保持しない版（GET /members に status が無い）。送信すると保存されないうえに system 発言を撒くので、送信しない')
  }
  if (!supported) { console.error(`seat-status-bridge: ${members.length} 席を見たが、server が未対応なので送っていない`); return NOTHING_ATTEMPTED }
  const now = Date.now()
  const observedAt = new Date(now).toISOString()
  const observations = await observer.cycle(members, last, observedAt)
  recordReady()
  let sent = 0
  let skipped = 0
  let failed = 0
  for (const member of members) {
    const { name } = member
    const prev = last.get(name)
    const observation = observations.get(name)
    // Aiterm席を持たない member（親など）は一度も観測できないので送らない
    if (!observation) { skipped++; continue }
    if (observation.error) {
      failed++
      console.error(`seat-status-bridge: ${name} の観測失敗: ${observation.error.code}: ${observation.error.message}`)
      continue
    }
    // 番犬（ターン終了検知・busy履歴）はpaneの生状態だけを読む。表示用の合成ランプ（job込み）を
    // ここへ流すと、静かなジョブの画面出力の間欠でランプがbusy⇄idleに揺れ、その揺れを
    // 「ターン終了」と誤認して正当待機の席へ[継続]を撃つ（実被弾 2026-08-25 #175: mio誤起床）。
    const paneStatus = observation.paneStatus
    const changed = !prev || prev.status !== observation.status
      || prev.busySince !== observation.busySince
      // token表示は実行中に細かく増える。1k未満の差で8秒ごとにPOSTせず、表示精度に合う粒度で送る。
      || tokenBucket(prev.paneTokenHint) !== tokenBucket(observation.paneTokenHint)
    const stale = prev && now - prev.at >= HEARTBEAT_MS
    if (!changed && !stale) continue
    try {
      await send(name, observation, observedAt)
      last.set(name, { ...observation, at: now })
      sent++
      const prevPane = paneLast.get(name)
      if ((paneStatus === 'busy' || paneStatus === 'blocked') && prevPane !== 'busy' && prevPane !== 'blocked') busyStartedAt.set(name, now)
      if (prevPane === 'busy' && paneStatus === 'idle') await nudgeIfDropped(name, prev?.busySince ?? null)
      paneLast.set(name, paneStatus)
      if (changed) console.error(`seat-status-bridge: ${name} → ${observation.status}${prev ? `（${prev.status} から）` : ''}`)
    } catch (e) {
      failed++
      console.error(`seat-status-bridge: ${name} の送信に失敗: ${e.message}`)
    }
  }
  // 0件でも0件と言う（条件付きログにしない。沈黙する失敗を作らない・決定58）
  console.error(`seat-status-bridge: ${members.length} 席を見て ${sent} 件送った（Aiterm席を持たず観測対象外: ${skipped}）`)
  await patrolClaims()
  return { attempted: sent + failed, failed }
}

// **書けることを実証してから常駐に入る。** `serverKeepsStatus()` は GET で「保存する版か」を
// 確かめる先例なのに、書込側は確かめずに常駐していた——だから「起動は成功したのに1件も届かない」
// という**見分けのつかない状態**が存在できた（2026-08-10 実測: トークン欠落で全件403のまま4時間）。
// 送るものが1件も無い tick は失敗ではない（席がまだ立っていない卓が正常にありうる）。
const FAILED_TICK_LIMIT = 10 // wakeup-bridge の連続失敗停止と同じ本数

function die(code, message) {
  console.error(`${code}: ${message}`)
  try { unlinkSync(pidPath) } catch { /* 既に消えている＝目的は達成されている */ }
  process.exit(1)
}

let failedTicks = 0
let provenWritable = false

async function guardedTick() {
  await beatBridge()
  const { attempted, failed } = await tick() ?? NOTHING_ATTEMPTED
  updateBridgeProgress(pidPath)
  const decided = decideBridgeContinuation({ attempted, failed, provenWritable, failedTicks, limit: FAILED_TICK_LIMIT })
  provenWritable = decided.provenWritable
  failedTicks = decided.failedTicks
  if (decided.verdict === 'write_denied') {
    die('SEAT_STATUS_BRIDGE_WRITE_DENIED',
      `送信 ${attempted} 件がすべて失敗し、一度も書けていない。常駐しない——書けない常駐は、`
      + '起動していない場合と同じ結果（点が出ない）を、起動しているように見せる。'
      + '書込トークン（環境変数 PEERTABLE_POST_TOKEN か ~/.config/peertable.env）と room の到達性を確認すること')
  }
  if (decided.verdict === 'unreachable') {
    die('SEAT_STATUS_BRIDGE_UNREACHABLE',
      `${FAILED_TICK_LIMIT} 回連続で全件送信に失敗した。黙って再試行を続けるゾンビを作らない（決定54）`)
  }
}

process.on('SIGTERM', () => { try { unlinkSync(pidPath) } catch {} process.exit(0) })
process.on('SIGINT', () => { try { unlinkSync(pidPath) } catch {} process.exit(0) })

try {
  await guardedTick()
  while (!once) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000))
    await guardedTick()
  }
} catch (error) {
  die('SEAT_STATUS_BRIDGE_OBSERVATION_FAILED', error.message)
} finally {
  await aiterm.close()
}
