#!/usr/bin/env node
// 親セッション自身が所有するバックグラウンド通知用の room watcher。
// room/SSE の解釈はここへ集約し、Claude Monitor / Codex background task は
// この process が stdout へ出す構造化 event を親へ返すことだけを担う。
//
// usage: parent-watch.mjs <project_dir> [parent_name] --prime
//        parent-watch.mjs <project_dir> [parent_name] --poll
//        parent-watch.mjs <project_dir> [parent_name] --next
//        parent-watch.mjs <project_dir> [parent_name] --follow
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLatticeExecutable, resolvePostToken } from './seat-usage.mjs'
import { addressedToParent as messageAddressedToParent, latticeStaffingChanged, tableStallUpdate } from './parent-watch-logic.mjs'

const args = process.argv.slice(2)
const project = args.shift()
let parent = 'bell'
if (args[0] && !args[0].startsWith('--')) parent = args.shift()
const mode = args.shift() ?? '--follow'
if (!project || !['--prime', '--poll', '--next', '--follow'].includes(mode) || args.length > 0) {
  console.error('usage: parent-watch.mjs <project_dir> [parent_name] <--prime|--poll|--next|--follow>')
  process.exit(2)
}

const team = join(project, '.team')
const setupPath = join(team, 'setup-state.json')
const statePath = join(team, 'parent-watch.json')
const lockPath = join(team, 'parent-watch.lock')
const setup = JSON.parse(readFileSync(setupPath, 'utf8'))
const room = setup.room
const serverUrl = setup.server_url.replace(/\/$/u, '')
const latticeCli = setup.lattice_cli || process.env.LATTICE_CLI || 'lattice'
const api = `${serverUrl}/api/${encodeURIComponent(room)}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => new Date().toISOString()
const ROOM_UPDATE_FALLBACK = 'room全体の状況が更新された。roomログを読み、状況を把握して次の行動を判断する。'
const staffingBody = ({ ready, active }) => `現在、着手可能工程は ${ready} 件、着手中工程は ${active} 件になりました。標準は ${ready + active}＋監査担当数です。円卓メンバー数を検討してください。`

function readLatticeState(previous = null) {
  const manifest = join(project, '.lattice', 'todo', 'manifest.json')
  if (!existsSync(manifest)) return null
  let info
  try { info = statSync(manifest) } catch { return null }
  const source = `${info.mtimeMs}:${info.size}`
  if (previous?.source === source && previous.error === undefined) return previous
  try {
    const lattice = resolveLatticeExecutable(latticeCli)
    const status = JSON.parse(execFileSync(lattice.command, lattice.argv, {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    if (!Array.isArray(status.next_ready) || !Array.isArray(status.active_set)) {
      throw new Error('invalid schema')
    }
    return { ready: status.next_ready.length, active: status.active_set.length, source }
  } catch {
    return { error: 'LATTICE_TODO_STATUS_FAILED', source }
  }
}

function loadState() {
  if (!existsSync(statePath)) return null
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    if (saved.room !== room || saved.server_url !== serverUrl || saved.parent !== parent) return null
    if (!Number.isSafeInteger(saved.last_seq) || saved.last_seq < 0) return null
    return saved
  } catch {
    return null
  }
}

function saveState(state) {
  const temp = `${statePath}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  renameSync(temp, statePath)
}

async function readJson(path) {
  const response = await fetch(`${api}${path}`)
  if (!response.ok) throw new Error(`${path} ${response.status}`)
  return response.json()
}

async function ensurePrimed() {
  const saved = loadState()
  if (saved) {
    let lattice = saved.lattice
    if (!lattice?.source) {
      const observed = readLatticeState()
      lattice = observed?.error ? null : observed
    }
    const next = {
      ...saved,
      lattice,
      ready_at: now(),
      host: process.env.PEERTABLE_PARENT_HOST || saved.host || null,
    }
    saveState(next)
    return next
  }
  const summary = await readJson('/summary')
  const observed = readLatticeState()
  const state = {
    schema: 'peertable.parent-watch-state.v1',
    room,
    server_url: serverUrl,
    parent,
    last_seq: Number.isSafeInteger(summary.seq) ? summary.seq : 0,
    lattice: observed?.error ? null : observed,
    ready_at: now(),
    host: process.env.PEERTABLE_PARENT_HOST || null,
  }
  saveState(state)
  return state
}

let state = await ensurePrimed()
if (mode === '--prime') process.exit(0)

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
function stopPid(pid) {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && alive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}
function acquireLock() {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner = null
    try { owner = Number(readFileSync(lockPath, 'utf8').trim()) } catch {}
    if (Number.isSafeInteger(owner) && owner === process.pid) return
    if (Number.isSafeInteger(owner) && alive(owner)) {
      process.stderr.write(`PARENT_WATCH_REPLACING: pid ${owner}\n`)
      stopPid(owner)
    }
    try { unlinkSync(lockPath) } catch {}
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  }
}
function releaseLock() {
  try {
    if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath)
  } catch {}
}
acquireLock()
process.on('exit', releaseLock)

const addressedToParent = message => messageAddressedToParent(message, parent)

function exitWhenParentStdinCloses() {
  if (mode !== '--follow') return
  // Claude Monitor など stdin を与えない persistent 実行では、stdin が最初から
  // 閉じているのを親端末の終了と誤認して即死する。stdin が TTY でない、または
  // PEERTABLE_WATCH_NO_STDIN=1 の時は stdin 追従を張らない（SKILL は Monitor 起動を指示する）。
  if (process.env.PEERTABLE_WATCH_NO_STDIN === '1') return
  const stdin = process.stdin
  if (!stdin || stdin.destroyed || stdin.isTTY !== true) return
  const quit = () => process.exit(0)
  stdin.on('end', quit)
  stdin.on('close', quit)
  if (typeof stdin.resume === 'function') stdin.resume()
}

async function writeEvent(event) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, error => error ? reject(error) : resolve())
  })
}

async function acceptLatticeState(next) {
  if (next === null) return false
  const previous = state.lattice
  if (next.error !== undefined) {
    if (previous?.error === next.error && previous.source === next.source) return false
    state = { ...state, lattice: { ...previous, ...next }, last_event_at: now() }
    saveState(state)
    await writeEvent({
      schema: 'peertable.parent-watch-event.v1',
      type: 'parent_lattice_error',
      parent,
      code: next.error,
      body: 'Lattice工程状態を取得できませんでした。親番犬のroom追従は継続します。',
    })
    return true
  }
  const changed = latticeStaffingChanged(previous, next)
  state = { ...state, lattice: next, last_event_at: now() }
  saveState(state)
  if (!changed) return false
  await writeEvent({
    schema: 'peertable.parent-watch-event.v1',
    type: 'parent_lattice_update',
    parent,
    ready: next.ready,
    active: next.active,
    standard_worker_count: next.ready + next.active,
    body: staffingBody(next),
  })
  return true
}

const receiptToken = resolvePostToken(process.env)
const postedParentReceipts = new Set()
async function postParentReceipt(seq) {
  if (postedParentReceipts.has(seq)) return
  postedParentReceipts.add(seq)
  try {
    const res = await fetch(`${serverUrl}/api/${encodeURIComponent(room)}/deliveries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(receiptToken ? { 'X-Peertable-Token': receiptToken } : {}) },
      body: JSON.stringify({ seq, recipient: parent, result: 'delivered', reason: 'parent_watch' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (error) {
    postedParentReceipts.delete(seq)
    process.stderr.write(`PARENT_RECEIPT_FAILED: seq=${seq} ${error.message}\n`)
  }
}

async function acceptMessage(message) {
  if (!Number.isSafeInteger(message?.seq) || message.seq <= state.last_seq) return false
  const matched = addressedToParent(message)
  if (matched) {
    const roomUpdate = message.to === 'all'
    await writeEvent({
      schema: 'peertable.parent-watch-event.v1',
      type: roomUpdate ? 'parent_room_update' : 'parent_dm',
      parent,
      seq: message.seq,
      from: message.from,
      to: message.to ?? null,
      to_names: message.to_names ?? null,
      body: roomUpdate ? (message.body || ROOM_UPDATE_FALLBACK) : message.body,
      message,
    })
    // 親宛の名指しDMは、この中継（writeEvent成功＝親の通知ストリームへ入った）をもって配達成立とし、
    // server の配送 receipt へ delivered(reason: parent_watch) を書く（2026-08-25 オーナー裁定）。
    // これが無いと送り手の席から親宛DMが永遠に pending に見え、報告の再記録ループで
    // 席のターンを燃やし続ける（実被弾: mio が報告のたびに「bell配達pending」を再送）。
    // to:"all" は席側配達（wakeup-bridge）が receipt を所有するので書かない。
    if (!roomUpdate) await postParentReceipt(message.seq)
  }
  state = { ...state, last_seq: message.seq, last_event_at: now() }
  saveState(state)
  return matched
}

// 「工程があるのに作業中の席が1つも無い」を親へ知らせる停滞警報。席の状態は
// seat-status-bridge が room members へ書く status を使う（親は延べ配信対象外）。
// members か Lattice を読めない tick は判定を進めず、前回の stall 状態を保つ。
const stallHoldMs = Number(process.env.PEERTABLE_STALL_ALARM_MS ?? 180_000)
async function checkStall() {
  const lattice = state.lattice
  if (!lattice || lattice.error !== undefined) return false
  let members
  try { members = (await readJson('/members')).members ?? [] } catch { return false }
  const workers = members
    .filter(m => m.name !== parent && m.delivery?.kind !== 'parent_watch')
    .map(m => ({ name: m.name, status: m.status ?? null }))
  const { stall, event } = tableStallUpdate(
    state.stall ?? null,
    { ready: lattice.ready, active: lattice.active, workers },
    Date.now(),
    stallHoldMs,
  )
  if (JSON.stringify(stall) !== JSON.stringify(state.stall ?? null)) {
    state = { ...state, stall, last_event_at: event ? now() : state.last_event_at }
    saveState(state)
  }
  if (!event) return false
  await writeEvent({
    schema: 'peertable.parent-watch-event.v1',
    parent,
    ...event,
  })
  return true
}

async function catchUp() {
  if (await acceptLatticeState(readLatticeState(state.lattice)) && mode === '--next') return true
  if (await checkStall() && mode === '--next') return true
  const body = await readJson(`/messages?since=${state.last_seq}`)
  for (const message of body.messages ?? []) {
    if (await acceptMessage(message) && mode === '--next') return true
  }
  return false
}

// Codex親のbackground task向け。HTTP catch-upを一度だけ行って即終了する。
// 長寿命なのはbackground taskのloopだけで、端末sessionやNode processは常駐させない。
if (mode === '--poll') {
  await catchUp()
  process.exit(0)
}

const nextWindowMs = Number(process.env.PEERTABLE_PARENT_WATCH_WINDOW_MS ?? 55_000)
if (mode === '--next' && (!Number.isFinite(nextWindowMs) || nextWindowMs < 100)) {
  console.error('PARENT_WATCH_WINDOW_INVALID')
  process.exit(2)
}

exitWhenParentStdinCloses()

let consecutiveFailures = 0
let snapshotSent = false
for (;;) {
  const deadline = mode === '--next' ? Date.now() + nextWindowMs : Number.POSITIVE_INFINITY
  try {
    if (await catchUp()) process.exit(0)
    if (mode === '--follow' && !snapshotSent) {
      snapshotSent = true
      const lattice = state.lattice
      await writeEvent({
        schema: 'peertable.parent-watch-event.v1',
        type: 'parent_watch_snapshot',
        parent,
        last_seq: state.last_seq,
        ready: lattice?.ready ?? null,
        active: lattice?.active ?? null,
        body: lattice && !lattice.error
          ? staffingBody(lattice)
          : '親番犬を張り直した。room の親宛と工程件数を追従する。',
      })
    }
    const controller = new AbortController()
    const remaining = Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : null
    const timer = remaining === null ? null : setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetch(`${api}/events`, { signal: controller.signal })
      if (!response.ok) throw new Error(`events ${response.status}`)
      consecutiveFailures = 0
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8')
        const frames = buffer.split('\n\n')
        buffer = frames.pop()
        for (const frame of frames) {
          const lines = frame.split('\n')
          const eventName = lines.find(line => line.startsWith('event: '))?.slice(7).trim()
          const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
          if (eventName === 'ping') {
            const head = Number(data)
            if (await acceptLatticeState(readLatticeState(state.lattice)) && mode === '--next') process.exit(0)
            if (await checkStall() && mode === '--next') process.exit(0)
            if (Number.isSafeInteger(head) && head > state.last_seq && await catchUp()) process.exit(0)
            continue
          }
          if (eventName !== undefined && eventName !== 'message') continue
          if (!data) continue
          if (await acceptMessage(JSON.parse(data)) && mode === '--next') process.exit(0)
        }
      }
      throw new Error('events disconnected')
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  } catch (error) {
    if (mode === '--next' && error.name === 'AbortError' && Date.now() >= deadline) process.exit(0)
    consecutiveFailures += 1
    if (consecutiveFailures >= 10) {
      await writeEvent({
        schema: 'peertable.parent-watch-event.v1',
        type: 'watch_error',
        parent,
        code: 'PARENT_WATCH_UNREACHABLE',
        detail: error.message,
      })
      process.exit(1)
    }
    if (mode === '--next' && Date.now() >= deadline) process.exit(0)
    await sleep(Math.min(2000, Math.max(1, deadline - Date.now())))
  }
}
