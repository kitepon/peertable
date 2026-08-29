#!/bin/bash
# 卓の健全性を機械判定して表示し、--repair 指定時だけ死んでいるブリッジを立て直す。
# usage: doctor.sh <project_dir> [--repair]
#
# 判定するのは5点だけ:
#   1. room サーバー到達性（GET /api/<room>/summary）
#   2. 台帳（room member 行）の素性・本人性の完全性
#   3. 各席の tmux セッション（peer-<name>）の存在と、席file の pid+lstart による本人性
#   4. 2ブリッジ（wakeup / seat-status）の record 生存と、record にある識別情報だけで
#      判定できる範囲の本人性・鮮度（判定できないものは「判定不能」と正直に出す。偽の生存判定を作らない）
#   5. Lattice 併用モード（mode=lattice）なら `lattice status --json` の state / active_runs
#
# 各行は OK / NG / REPAIRED / 判定不能 のいずれかで始まる。--repair は NG のブリッジだけ
# ensure-bridge.sh で立て直す。**席の再起動はしない**——席は人の判断が要るので、NG 表示に
# launch-seat.sh を促す一言を添えるだけに留める。
#
# 終了コード: 全 OK（判定不能を含む）= 0、NG が1件でもあれば 1（--repair で全部直れば 0）。
set -euo pipefail

proj="${1:-}"
repair=false
if [ "${2:-}" = "--repair" ]; then repair=true; fi
if [ -z "$proj" ]; then
  echo "usage: doctor.sh <project_dir> [--repair]" >&2
  exit 1
fi
proj=$(cd "$proj" && pwd)
script_dir=$(cd "$(dirname "$0")" && pwd)
setup="$proj/.team/setup-state.json"
if [ ! -f "$setup" ]; then
  echo "NG .team/setup-state.json が無い（${proj} は peertable setup 済みか確認せよ）" >&2
  exit 1
fi

DOCTOR_PROJ="$proj" DOCTOR_SCRIPT_DIR="$script_dir" DOCTOR_REPAIR="$repair" \
  node --input-type=module <<'NODE'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const proj = process.env.DOCTOR_PROJ
const scriptDir = process.env.DOCTOR_SCRIPT_DIR
const repair = process.env.DOCTOR_REPAIR === 'true'
const team = join(proj, '.team')

const { bridgeRecordLive } = await import(pathToFileURL(join(scriptDir, 'bridge-record-live.mjs')))
const { observePidCommand } = await import(pathToFileURL(join(scriptDir, 'refresh-seat-identity.mjs')))
const { resolveLatticeInvocation, resolveTmuxSocket, tmuxArgv } = await import(pathToFileURL(join(scriptDir, 'seat-usage.mjs')))

let ng = 0
function line(level, text) {
  console.log(`${level} ${text}`)
  if (level === 'NG') ng = 1
}

const setup = JSON.parse(readFileSync(join(team, 'setup-state.json'), 'utf8'))
const { room, server_url: url, mode } = setup

// 1. room サーバー到達性
let summary = null
try {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/summary`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  summary = await res.json()
  line('OK', `room 到達: ${url} room=${room} seq=${summary.seq} member_count=${summary.member_count}`)
} catch (error) {
  line('NG', `room 到達不可: ${url} room=${room}（${error.message}）`)
}

// members は以降の突合・席チェックにも使う
let members = []
let membersOk = false
try {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  members = Array.isArray(body.members) ? body.members : []
  membersOk = true
} catch (error) {
  line('NG', `room members を取得できない（${error.message}）`)
}

// 2. 台帳の完全性。tmux 席を持つ member（親以外）は本人性欄（pid 等）も台帳に載っている
// はず（席file は 2026-08-22 廃止・正本は member 行だけ）
function hasDescriptor(member) {
  return Boolean(member?.observe && typeof member.observe === 'object'
    && typeof member.observe.tmux_target === 'string' && member.observe.tmux_target.length > 0)
}
const seatRows = new Map()
if (membersOk) {
  const seated = members.filter(hasDescriptor)
  const missingIdentity = seated.filter(m => !Number.isSafeInteger(m.pid) || !m.started_identity || !m.argv_digest)
  for (const m of seated) seatRows.set(m.name, m)
  if (missingIdentity.length === 0) {
    line('OK', `台帳の member 行に素性・本人性が揃っている（${seated.length} 席）`)
  } else {
    line('NG', `台帳の本人性欄が欠けている member: ${missingIdentity.map(m => m.name).join(',')}`)
  }
}

// 3. 各席の tmux セッション（peer-<name>）の存在と、台帳の pid+lstart による本人性
for (const [name, seat] of seatRows) {
  const member = seat
  const socket = member?.observe?.tmux_socket || resolveTmuxSocket(process.env).socket
  const target = member?.observe?.tmux_target || `peer-${name}`
  let sessionExists = false
  try {
    execFileSync('tmux', tmuxArgv(['has-session', '-t', target], { socket }), { stdio: 'ignore' })
    sessionExists = true
  } catch { /* has-session は非ゼロ終了で無しを表す */ }
  if (!sessionExists) {
    line('NG', `席 ${name}: tmux セッション ${target} が無い（launch-seat.sh で立て直す）`)
    continue
  }
  let identity = null
  let identityError = null
  try { identity = observePidCommand(seat.pid) } catch (error) { identityError = error }
  if (identityError) {
    line('NG', `席 ${name}: pid ${seat.pid} を観測できない（${identityError.message}）（launch-seat.sh で立て直す）`)
    continue
  }
  if (identity.started_identity !== seat.started_identity) {
    line('NG', `席 ${name}: pid ${seat.pid} は再利用されている（lstart不一致・本人ではない）（launch-seat.sh で立て直す）`)
    continue
  }
  line('OK', `席 ${name}: tmux ${target} 生存・pid ${seat.pid} 本人性確認`)
}

// 4. 2ブリッジ（run-bridge は 2026-08-22 退役）。record の形式が違うので判定できる範囲だけ判定する
function judgeWakeup() {
  const path = join(team, 'wakeup-bridge.json')
  if (!existsSync(path)) return { level: 'NG', text: 'wakeup-bridge: record が無い（起動していない）' }
  const record = JSON.parse(readFileSync(path, 'utf8'))
  if (bridgeRecordLive(record)) {
    const age = Math.round((Date.now() - Date.parse(record.last_progress_at)) / 1000)
    return { level: 'OK', text: `wakeup-bridge: 生存 pid=${record.pid} last_progress ${age}秒前` }
  }
  return { level: 'NG', text: `wakeup-bridge: pid=${record.pid} が死んでいるか last_progress_at が古い` }
}

function judgeSeatStatusBridge() {
  const path = join(team, 'seat-status-bridge.json')
  if (!existsSync(path)) return { level: 'NG', text: 'seat-status-bridge: record が無い（起動していない）' }
  const record = JSON.parse(readFileSync(path, 'utf8'))
  let alive = false
  try { process.kill(record.pid, 0); alive = true } catch { /* 死んでいる */ }
  if (!alive) return { level: 'NG', text: `seat-status-bridge: pid=${record.pid} が死んでいる` }
  return { level: '判定不能', text: `seat-status-bridge: pid=${record.pid} は生存しているが record に lstart が無く本人性を確認できない` }
}

for (const [name, judge] of [['wakeup', judgeWakeup], ['seat-status', judgeSeatStatusBridge]]) {
  let result = judge()
  if (result.level === 'NG' && repair) {
    const res = spawnSync(join(scriptDir, 'ensure-bridge.sh'), [proj, name], { encoding: 'utf8' })
    if (res.status === 0) {
      const after = judge()
      if (after.level !== 'NG') { line('REPAIRED', `${name}-bridge: 立て直した（${after.text}）`); continue }
      line('NG', `${name}-bridge: 立て直したが依然として不健全（${after.text}）`)
      continue
    }
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' / ')
    line('NG', `${name}-bridge: 立て直しに失敗（${detail || `exit ${res.status}`}）`)
    continue
  }
  line(result.level, result.text)
}

// 4.5 端末別の装置可用性（silent absence禁止・2026-08-25 オーナー裁定）:
// この端末で「動かない」なら動かないと表示する。黙ってMacだけで動く状態を作らない。
{
  // job観測（アクティブランプへの預け仕事合成）: tmux list-sessions がこの端末で成立するか
  try {
    const probe = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
    if (probe.error) throw probe.error
    line('OK', `job観測: tmux list-sessions 実行可（ランプ合成は有効。ジョブは席のシェルからtmuxセッションで走らせる——名前は自由）`)
  } catch (error) {
    line('NG', `job観測: tmux list-sessions が失敗——預け仕事のランプ合成はこの端末で無効（${String(error.message ?? error).split('\n')[0]}）`)
  }
  // env帰属（2026-08-26 オーナー裁定: 帰属は規約名でなくOSの環境変数継承）: この端末のtmux/psmuxが
  // update-environment と show-environment を持つか。持たない実装（psmuxの互換欠け等）では
  // 名前fallback（peer-<name>- 前置）だけで動くので、その事実を機械判定で出す。
  try {
    const opts = execFileSync('tmux', tmuxArgv(['show-options', '-g', 'update-environment'], { socket: resolveTmuxSocket(process.env).socket }), { encoding: 'utf8' })
    if (/PEERTABLE_MEMBER/.test(opts)) line('OK', 'env帰属: update-environment に PEERTABLE_MEMBER が載っている（新規セッションへ持ち主が自動継承される）')
    else line('NG', 'env帰属: update-environment に PEERTABLE_MEMBER が無い——launch-seat をこの版で一度通すと設定される。それまで帰属は peer-<name>- 前置の名前fallbackのみ')
  } catch (error) {
    line('NG', `env帰属: show-options が失敗——この端末のtmux/psmuxはenv帰属を判定できず、名前fallbackのみで動作（${String(error.message ?? error).split('\n')[0]}）`)
  }
  // 読了ack: server members に read_seq 欄が観測できるか（席が一度もackしていない間は判定できない）
  try {
    const res = JSON.parse(execFileSync('curl', ['-s', `${url}/api/${encodeURIComponent(room)}/members`], { encoding: 'utf8' }))
    const withAck = (res.members ?? []).filter(m => m.read_seq !== undefined).length
    if (withAck > 0) line('OK', `読了ack: server対応を確認（read_seq保持 ${withAck} 席）`)
    else line('判定不能', '読了ack: read_seq を持つ席がまだ無い（旧serverか、席が一度も read_unread→post していないか区別できない）')
  } catch (error) {
    line('NG', `読了ack: members を読めない（${String(error.message ?? error).split('\n')[0]}）`)
  }
}

// 5. Lattice 併用モードの工程正本
if (mode === 'lattice') {
  const latticeCli = process.env.LATTICE_CLI || (typeof setup.lattice_cli === 'string' && setup.lattice_cli) || 'lattice'
  try {
    const invocation = resolveLatticeInvocation(latticeCli, ['status', '--json'])
    const out = execFileSync(invocation.command, invocation.argv, { cwd: proj, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const status = JSON.parse(out)
    line('OK', `Lattice: state=${status.state} active_runs=${(status.active_runs ?? []).length}`)
  } catch (error) {
    line('NG', `Lattice status を取得できない（${String(error.message ?? error).split('\n')[0]}）`)
  }
}

process.exit(ng)
NODE
