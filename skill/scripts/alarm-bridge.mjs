#!/usr/bin/env node
// 目覚まし係（2026-08-22 オーナー設計）。AI ではない常駐スクリプト。
//
// 席は「待機からの解放条件を判定するスクリプト」を登録してから寝る（alarm-set.sh）。
// 本常駐が高頻度でそのスクリプトを回し、exit 0 になったら登録席へ
// 「[待機解放条件成立] <note>」の DM を room へ置く（配達は wakeup-bridge の正規経路）。
// 条件の約束が席の揮発文脈でなく装置に住むので、依頼相手の死・レース負け・宛先不在・
// 外部/時刻条件・相互待機のどれでも待機が永眠しない。
//
// usage: alarm-bridge.mjs <project_dir>            起動（nohup で常駐）
//        alarm-bridge.mjs <project_dir> --stop     停止
//
// 登録: .team/alarms/<id>.json
//   { "seat": "ren", "note": "転写job j42 完了", "script": "test -f ~/asr/jobs/j42/result.json",
//     "interval_s": 10, "created_at": "..." }
// スクリプトは bash -c で実行される（timeout 30秒）。exit 0 = 条件成立。
// 成立したら DM を置いて登録 file を削除する。スクリプトのエラーは成立と区別してログへ出す。
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolvePostToken } from './seat-usage.mjs'
import { observePidCommand } from './seat-identity.mjs'

const run = promisify(execFile)
const [proj, flag] = process.argv.slice(2)
if (!proj) { console.error('usage: alarm-bridge.mjs <project_dir> [--stop]'); process.exit(1) }

const team = join(proj, '.team')
const alarmsDir = join(team, 'alarms')
const record = join(team, 'alarm-bridge.json')
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = line => console.error(`[${new Date().toISOString()}] ${line}`)

// 停止・再認証は run-bridge と同じ作法（pid+lstart 照合。pid 再利用先を殺さない）
function stopRecorded(strict) {
  if (!existsSync(record)) { if (strict) log('起動記録が無い（既に停止）'); return }
  const stored = JSON.parse(readFileSync(record, 'utf8'))
  let facts = null
  try { facts = observePidCommand(stored.pid) } catch { /* 観測不能=死亡扱い */ }
  const same = facts && stored.start_identity !== undefined
    && facts.started_identity === stored.start_identity && facts.argv.includes('alarm-bridge.mjs')
  if (!same) { unlinkSync(record); log(`死んだ記録を掃除した（pid ${stored.pid}）`); return }
  process.kill(stored.pid, 'SIGTERM')
  log(`前の目覚まし係を停止した（pid ${stored.pid}）`)
  try { unlinkSync(record) } catch { /* 本人のcleanupと競合してよい */ }
}
stopRecorded(flag === '--stop')
if (flag === '--stop') process.exit(0)

const setup = JSON.parse(readFileSync(join(team, 'setup-state.json'), 'utf8'))
const { room, server_url: url } = setup
const token = resolvePostToken(process.env)
if (!token) { console.error('ALARM_BRIDGE_TOKEN_MISSING: 書込トークンが無い'); process.exit(1) }
mkdirSync(alarmsDir, { recursive: true })

const self = observePidCommand(process.pid)
writeFileSync(record, JSON.stringify({
  pid: process.pid, start_identity: self.started_identity, room, server_url: url,
  started_at: new Date().toISOString(), ready_at: new Date().toISOString(),
}) + '\n')
const cleanup = () => { try { unlinkSync(record) } catch {} process.exit(0) }
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)

async function wake(seat, note) {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token },
    body: JSON.stringify({ from: 'alarm', to: seat, body: `[待機解放条件成立] ${note}` }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

const nextDue = new Map() // file -> epoch_ms
async function tick() {
  let entries
  try { entries = readdirSync(alarmsDir).filter(f => f.endsWith('.json')) } catch { return }
  for (const entry of entries) {
    const file = join(alarmsDir, entry)
    const due = nextDue.get(file) ?? 0
    if (Date.now() < due) continue
    let reg
    try { reg = JSON.parse(readFileSync(file, 'utf8')) } catch { continue } // 書込途中は次周へ
    if (typeof reg.seat !== 'string' || typeof reg.script !== 'string' || !reg.seat || !reg.script) {
      log(`ALARM_REGISTRATION_INVALID: ${entry}（seat/script が無い）を撤去する`)
      try { unlinkSync(file) } catch {}
      continue
    }
    nextDue.set(file, Date.now() + Math.max(2, Number(reg.interval_s) || 10) * 1000)
    let met = false
    let firedOutput = ''
    try {
      const { stdout, stderr } = await run('bash', ['-c', reg.script], { timeout: 30_000, maxBuffer: 1024 * 1024 })
      met = true
      // 発火の証拠を残す: fail-open型の条件は「なぜ成立したか」が出力にしか現れない
      // （実被弾 2026-08-26: statusの一過性失敗で即発火したが、何が失敗したか記録が無く未解明）
      firedOutput = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, 300)
    } catch (e) {
      // exit 非0 = 条件未成立（正常）。timeout/spawn 失敗はログへ（成立と区別し、握りつぶさない）
      if (e.killed || e.code === 'ENOENT') log(`条件スクリプトの実行失敗（${entry}）: ${e.message}`)
    }
    if (!met) continue
    try {
      await wake(reg.seat, reg.note || entry)
      unlinkSync(file)
      nextDue.delete(file)
      log(`起床: ${reg.seat} ← ${reg.note || entry}${firedOutput ? `｜条件出力: ${firedOutput}` : ''}`)
    } catch (e) {
      log(`起床の投函に失敗（次周期に再試行）: ${e.message}`)
    }
  }
}

log(`alarm-bridge start: room=${room} project=${proj} pid=${process.pid}`)
for (;;) {
  try { await tick() } catch (e) { log(`tick 失敗（続行）: ${e.message}`) }
  await sleep(2000)
}
