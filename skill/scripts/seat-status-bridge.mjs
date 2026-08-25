#!/usr/bin/env node
// 席の稼働状態ブリッジ（決定61 候補・t15）。tmux の pane を読んで busy/idle/dead を判定し、room サーバーへ送る。
// usage: seat-status-bridge.mjs <project_dir> [--interval <sec>] [--once]
//        seat-status-bridge.mjs <project_dir> --stop
//
// AI は使わない。読むのは `tmux capture-pane -p` の末尾だけで、席へは1バイトも送らない。
//
// 判定（2026-08-08 実測。**推測でパターンを書かない**）:
//   busy    = pane の末尾に `esc to interrupt` が在る。Claude 席のステータス行にも Codex 席の `Working (…)` にも
//             同じ文字列が入る。Grok はこれを出さず `Waiting for response` / `Responding…` / `[stop]` を出す
//             （2026-08-21 実測。これを見ないと作業中の Grok 席が idle に見える）。実行中の動名詞
//             （Cogitating/Coalescing/Effecting/Gallivanting/Fermenting/Symbioting…）は**毎回変わる**ので
//             判定に使わない——語で照合すると全席を idle と誤判定して、画面が嘘をつく
//   blocked = 既知の承認ダイアログ文言が末尾に在る（`esc to interrupt` は消えている）。2026-08-08 実測:
//             確認ダイアログで停止した席が busy と `esc to interrupt` 不在から idle 側に誤判定され、
//             動けない席へ卓が代走を申し出るところまで進んだ。判定順は busy → blocked → idle
//             （承認プロンプト表示中は `esc to interrupt` が消えるので、この順で正しい）
//   dead    = tmux セッションが無い／`pane_dead=1`／画面は idle 風だが中の CLI プロセスが停止
//             （`ps` stat 先頭 `T`。Lattice pull run の accept hold が attach 済み worker へ
//             SIGSTOP を送る局面等。2026-08-11 実測）
//   idle    = 生きていて busy でも blocked でもない
//
// 送信は「変化した時」＋「変化が無くても心拍」の2本立て。変化時だけだと、**bridge が死んだのか状態が
// 変わっていないのかを server が区別できない**（決定58 の liveness と cursor の分離と同じ形）。
// server 側は最終受信からの経過で `unknown` へ落とす——古い状態を出し続けるのが最悪だから。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { STOP_DECLARATION, combineSeatLamp, hasActiveDescendant, patrolTargets, classifyPaneTail, decideBridgeContinuation, deriveMissingSession, isPaneProcessStopped, parsePaneTokenHint, resolvePostToken, resolveSeatObservation, resolveTmuxSocket, supportsMemberObservation, tmuxArgv, tmuxPanePid } from './seat-usage.mjs'

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
    for (let i = 0; i < 50 && alive(pid); i++) execFileSync('sleep', ['0.1'])
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
      for (let i = 0; i < 30 && alive(pid); i++) execFileSync('sleep', ['0.1'])
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

// 記述子がある席は既定 socket を要らない。曖昧な既定 socket のせいで観測可能な席まで止めないよう、
// legacy 席を読む時だけ解決する。
let defaultSocketResolution = null
let resolutionLogged = false
let readyRecorded = false
const defaultSocket = () => {
  if (defaultSocketResolution === null) defaultSocketResolution = resolveTmuxSocket(process.env)
  return defaultSocketResolution.socket
}
const tmux = (socket, ...a) => { try { return execFileSync('tmux', tmuxArgv(a, { socket }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null } }

// 監視するのは room の members に居る席だけ。tmux の `peer-*` を全部拾うと、同じマシンで走る別の卓を晒す
async function seats() {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
  const { members } = await res.json()
  return members
}

function readSeat(member, previous, observedAt) {
  // まず記述子だけで解決する。socket が無い記述子／記述子なしの場合だけ既定を調べる。
  const target = resolveSeatObservation(member, null) ?? resolveSeatObservation(member, defaultSocket())
  if (target === null) return deriveMissingSession(previous)
  const dead = tmux(target.socket, 'list-panes', '-t', target.target, '-F', '#{pane_dead}')
  // セッションが見つからない。tmux 席を持たない member（親など）は一度も観測できないので送らない
  // （`previous` が無い＝一度も観測できていない）。過去に観測できていた席が消えたなら実際に落ちた
  if (dead === null) return deriveMissingSession(previous)
  if (dead.trim().split('\n')[0] === '1') {
    return { status: 'dead', busySince: null, paneTokenHint: null }
  }
  const pane = tmux(target.socket, 'capture-pane', '-t', target.target, '-p')
  if (pane === null) return { status: 'dead', busySince: null, paneTokenHint: null }
  const tail = pane.split('\n').slice(-14).join('\n')
  const tentativeStatus = classifyPaneTail(tail)
  // pane 自体は生きたまま中の CLI プロセスだけが停止する局面（Lattice pull run の accept hold 等）を
  // 拾う。画面の残像だけでは idle に誤判定するため、idle と読めた時だけ実プロセスの stat を見る。
  const status = tentativeStatus === 'idle' && isPaneProcessStopped(tmuxPanePid(target.socket, target.target))
    ? 'dead'
    : tentativeStatus
  const busySince = status === 'busy' || status === 'blocked'
    ? ((previous?.status === 'busy' || previous?.status === 'blocked') && previous.busySince ? previous.busySince : observedAt)
    : null
  return { status, busySince, paneTokenHint: parsePaneTokenHint(tail) }
}

// ---- 預け仕事（jobセッション）の観測（2026-08-25 オーナー裁定）----
// 席が常駐・長時間ジョブを `peer-<名前>-job*` の名前のtmuxセッションで走らせる取り決めを前提に、
// その実物を毎周期観測してランプへ合成する。登録・宣言は一切見ない——観測だけ。
// active判定は「画面内容が前周期から変わった」こと。出力を出さない計算中はidle表示になるが、
// それは観測できる事実の正直な表示であり、推測で点滅させない。
const jobPaneHash = new Map() // `${name}:${session}` -> { hash, changedAt }
let jobObserveFailureLogged = false
function observeJob(socket, name) {
  const listed = tmux(socket, 'list-sessions', '-F', '#{session_name}')
  if (listed === null) {
    // 「jobなし」と「観測手段が壊れている」を同じ顔にしない（silent absence禁止・2026-08-25 オーナー裁定）。
    // この端末でjob観測が成立しない場合、ランプ合成は席paneのみで動いていることを明示的に吠える。
    if (!jobObserveFailureLogged) {
      jobObserveFailureLogged = true
      console.error('JOB_OBSERVE_UNAVAILABLE: tmux list-sessions が失敗するため、預け仕事のランプ合成はこの端末で無効（席paneのみで表示）。以後この警告は繰り返さない')
    }
    return { alive: false, active: false }
  }
  jobObserveFailureLogged = false
  const sessions = listed.split('\n').filter(s => s.startsWith(`peer-${name}-job`))
  if (sessions.length === 0) return { alive: false, active: false }
  let active = false
  for (const session of sessions) {
    const pane = tmux(socket, 'capture-pane', '-t', session, '-p')
    if (pane === null) continue
    const hash = String(pane.length) + ':' + pane.slice(-256)
    const key = `${name}:${session}`
    const prev = jobPaneHash.get(key)
    if (!prev || prev.hash !== hash) { jobPaneHash.set(key, { hash }); active = true }
  }
  return { alive: true, active }
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
const patrolLastNag = new Map() // seat -> epoch_ms
const busyStartedAt = new Map() // seat -> epoch_ms（このbridgeプロセスが観測した最後のターン開始）
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
    const latticeCommand = process.platform === 'win32' && !/\.(cmd|bat|exe)$/i.test(latticeCli) && existsSync(`${latticeCli}.cmd`)
      ? `${latticeCli}.cmd`
      : latticeCli
    const out = execFileSync(latticeCommand, ['todo', 'status', '--json'], { cwd: proj, encoding: 'utf8' })
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
  for (const { seat, task } of targets) {
    patrolLastNag.set(seat, now)
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

function hasDescriptor(member) {
  return member?.observe && typeof member.observe === 'object'
    && typeof member.observe.tmux_target === 'string' && member.observe.tmux_target.length > 0
}

function logResolution(members) {
  if (resolutionLogged) return
  resolutionLogged = true
  const descriptors = members.filter(hasDescriptor).length
  const legacy = members.length - descriptors
  if (legacy === 0) {
    console.error(`seat-status-bridge: 観測記述子 ${descriptors} 席、legacy 0 席、既定 socket は未使用`)
    return
  }
  const resolved = defaultSocketResolution ?? resolveTmuxSocket(process.env)
  defaultSocketResolution = resolved
  const detail = resolved.error
    ? `${resolved.source} (${resolved.error.code}: ${resolved.candidates.join(', ')})`
    : `${resolved.source} (${resolved.socket})`
  console.error(`seat-status-bridge: 観測記述子 ${descriptors} 席、legacy ${legacy} 席、既定 socket=${detail}`)
}

function recordReady() {
  if (readyRecorded) return
  readyRecorded = true
  const record = JSON.parse(readFileSync(pidPath, 'utf8'))
  const temporary = `${pidPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...record, ready_at: new Date().toISOString() }) + '\n')
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
    recordReady()
    if (!supported) console.error('seat-status-bridge: この room サーバーは稼働状態を保持しない版（GET /members に status が無い）。送信すると保存されないうえに system 発言を撒くので、送信しない')
  }
  logResolution(members)
  if (!supported) { console.error(`seat-status-bridge: ${members.length} 席を見たが、server が未対応なので送っていない`); return NOTHING_ATTEMPTED }
  const now = Date.now()
  const observedAt = new Date(now).toISOString()
  let sent = 0
  let skipped = 0
  let failed = 0
  for (const member of members) {
    const { name } = member
    const prev = last.get(name)
    const observation = readSeat(member, prev, observedAt)
    // tmux 席を持たない member（親など）は一度も観測できないので送らない（deriveMissingSession が null を返す）
    if (observation === null) { skipped++; continue }
    {
      const target = resolveSeatObservation(member, null) ?? resolveSeatObservation(member, defaultSocket())
      if (target !== null) {
        const job = observeJob(target.socket, member.name)
        // 席paneの子孫プロセス（Codex内蔵background terminal等）の実働もjob稼働として合成する
        if (!job.active && observation.status === 'idle') {
          const panePid = tmuxPanePid(target.socket, target.target)
          if (panePid) {
            try {
              const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu='], { encoding: 'utf8' }).split('\n')
              if (hasActiveDescendant(rows, Number(panePid))) job.active = true
            } catch { /* psが失敗する端末では子孫観測なしで続行（named session観測は生きている） */ }
          }
        }
        observation.status = combineSeatLamp(observation.status, job)
      }
    }
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
      if ((observation.status === 'busy' || observation.status === 'blocked') && prev?.status !== 'busy' && prev?.status !== 'blocked') busyStartedAt.set(name, now)
      if (prev?.status === 'busy' && observation.status === 'idle') await nudgeIfDropped(name, prev.busySince)
      if (changed) console.error(`seat-status-bridge: ${name} → ${observation.status}${prev ? `（${prev.status} から）` : ''}`)
    } catch (e) {
      failed++
      console.error(`seat-status-bridge: ${name} の送信に失敗: ${e.message}`)
    }
  }
  // 0件でも0件と言う（条件付きログにしない。沈黙する失敗を作らない・決定58）
  console.error(`seat-status-bridge: ${members.length} 席を見て ${sent} 件送った（tmux席を持たず観測対象外: ${skipped}）`)
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

await guardedTick()
if (!once) setInterval(() => { guardedTick() }, interval * 1000)
