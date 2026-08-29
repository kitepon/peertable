#!/bin/bash
# 既存 room の正規 resume（決定105）。過去ログを残した同じ room を、現行工程へ接続し直して再稼働させる。
# usage: resume.sh <project_dir> [--plan <plan_key>] [--phase <id>]... [--no-probe]
#
# 一回で行うこと:
#   1. 既存 .team/ と room の確認（無ければ setup.sh を案内して止まる）
#   2. --plan 指定時、setup-state.json / roles/member.md / 外部ペインを現行 plan へ再束縛
#   3. 死んだ bridge 記録（pid 不一致・停止）の除去
#   4. 台帳（room member 行）から現行メンバー構成を読み、席が死んでいるものだけ launch-seat.sh で再起動
#      （credential の再生成・本人性の再記録は launch-seat.sh が持つ）
#   5. alarm / seat-status / wakeup bridge の再起動（ensure-bridge.sh）
#   6. fresh heartbeat の読み戻し（server 実効状態が fresh になるまで待つ）
#   7. テスト DM の配送 receipt 確認（delivered になるまで待つ。--no-probe で省略）
#
# 手書きのメンバー一覧・個別再起動 script には依存しない。親の再着卓（parent-join / 番犬）は別手順
#（SKILL.md「親の再着卓」）——resume は席と bridge の面だけを持つ。
set -euo pipefail

proj="${1:-}"
[ -n "$proj" ] || { echo "usage: resume.sh <project_dir> [--plan <plan_key>] [--phase <id>]... [--no-probe]" >&2; exit 1; }
shift
plan=""
phases=()
probe=true
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) plan="${2:-}"; shift 2 ;;
    --phase) [ -n "${2:-}" ] || { echo "ERROR: --phase には phase id が要る" >&2; exit 1; }; phases+=("$2"); shift 2 ;;
    --no-probe) probe=false; shift ;;
    *) echo "ERROR: 未知の引数: $1" >&2; exit 1 ;;
  esac
done
proj=$(cd "$proj" && pwd)
script_dir=$(cd "$(dirname "$0")" && pwd -P)
repo="${PEERTABLE_REPO:-$(cd "$script_dir/../.." && pwd -P)}"
[ -f "$repo/room/client.mjs" ] || { echo "RESUME_PEERTABLE_TREE_UNRESOLVED: $repo が peertable tree でない" >&2; exit 1; }
setup="$proj/.team/setup-state.json"
if [ ! -f "$setup" ]; then
  echo "RESUME_NOT_SET_UP: $setup が無い。新規の卓は setup.sh で立てること" >&2
  exit 1
fi

# resumeは同じroomを現行Peertable treeへ再接続する入口である。席が全て生存していて再起動0件でも、
# Peertable所有のgenerated assetとroot room MCPを先に現行版へ更新する。
"$script_dir/upgrade-team-assets.sh" "$proj"

seats_file="$proj/.team/resume-seats.json"

# Phase A: 到達確認・plan 再束縛・死記録掃除・再起動対象の抽出（node が JSON を書き出す）
RESUME_PROJ="$proj" RESUME_REPO="$repo" RESUME_PLAN="$plan" RESUME_PHASES="${phases[*]:-}" \
RESUME_SEATS_FILE="$seats_file" node --input-type=module <<'NODE'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const proj = process.env.RESUME_PROJ
const repo = process.env.RESUME_REPO
const team = join(proj, '.team')
const scriptDir = join(repo, 'skill', 'scripts')
const { bridgeRecordLive } = await import(pathToFileURL(join(scriptDir, 'bridge-record-live.mjs')))
const { resolveSeatObservation, tmuxArgv } = await import(pathToFileURL(join(scriptDir, 'seat-usage.mjs')))

const setupPath = join(team, 'setup-state.json')
const state = JSON.parse(readFileSync(setupPath, 'utf8'))
const { room, server_url: url } = state

// 1. room の存在確認（読み取りは room を作らないので、summary が member 0・seq 0 でも部屋の有無は API 一覧で見る）
const roomsRes = await fetch(`${url}/api/rooms`).catch((e) => { throw new Error(`RESUME_ROOM_UNREACHABLE: ${url} へ到達できない: ${e.message}`) })
if (!roomsRes.ok) throw new Error(`RESUME_ROOM_UNREACHABLE: GET /api/rooms -> HTTP ${roomsRes.status}`)
const { rooms } = await roomsRes.json()
if (!rooms.includes(room)) throw new Error(`RESUME_ROOM_MISSING: room「${room}」が server に無い。新規は setup.sh で立てること`)
console.log(`[実施] room 確認: ${room} @ ${url}`)

// 2. plan 再束縛（--plan 指定時だけ）
const plan = process.env.RESUME_PLAN
const phases = (process.env.RESUME_PHASES ?? '').split(' ').filter(Boolean)
if (plan) {
  state.mode = 'lattice'
  state.plan_key = plan
  state.phases = phases
  writeFileSync(setupPath, JSON.stringify(state) + '\n')
  const scope = phases.length === 0
    ? 'この卓の claim 範囲は plan 全体（phase 指定なしで立っている）。'
    : `**この卓の claim 範囲は phase ${phases.join(' ')} の task だけ**。範囲外の phase の task は、ready に見えていても取らない。範囲外に手を入れる必要が出たら room へ出して裁定を仰ぐ。`
  const template = readFileSync(join(repo, 'skill', 'templates', 'member.md'), 'utf8')
  writeFileSync(join(team, 'roles', 'member.md'), template.replaceAll('{{PLAN_KEY}}', plan).replaceAll('{{CLAIM_SCOPE}}', scope))
  const publicUrl = process.env.PEERTABLE_PUBLIC_URL ?? state.public_url ?? url
  execFileSync('node', [join(scriptDir, 'external-pane.mjs'), proj, room, publicUrl], { stdio: ['ignore', 'ignore', 'inherit'] })
  console.log(`[実施] plan 再束縛: ${plan}${phases.length ? `（phase ${phases.join(',')}）` : ''}`)
} else {
  console.log(`[スキップ] plan 再束縛（--plan 未指定。現行 ${state.plan_key || state.mode} のまま）`)
}

// 3. 死んだ bridge 記録の除去（生きている記録は触らない。parent-watch.json は cursor 正本なので消さない）
for (const name of ['wakeup-bridge.json', 'seat-status-bridge.json', 'alarm-bridge.json']) {
  const path = join(team, name)
  if (!existsSync(path)) continue
  let record = null
  try { record = JSON.parse(readFileSync(path, 'utf8')) } catch {}
  if (bridgeRecordLive(record)) { console.log(`[スキップ] ${name}: 生存中（pid ${record.pid}）`); continue }
  unlinkSync(path)
  console.log(`[実施] ${name}: 死んだ記録を除去（pid ${record?.pid ?? '不明'}）`)
}

// 4. 台帳から再起動対象を抽出。席の生死は tmux session の実在で判定する
const { members } = await (await fetch(`${url}/api/${encodeURIComponent(room)}/members`)).json()
const relaunch = []
const missingRoles = []
for (const member of members) {
  if (member.delivery?.kind === 'parent_watch') continue
  const harness = member.harness ?? member.vendor
  if (!harness) continue // 素性の無い行（親の手動登録等）は席ではない
  const observation = resolveSeatObservation(member, null)
  let aliveSeat = false
  if (observation) {
    try {
      execFileSync('tmux', tmuxArgv(['has-session', '-t', observation.target], { socket: observation.socket }), { stdio: 'ignore' })
      aliveSeat = true
    } catch {}
  }
  if (aliveSeat) { console.log(`[スキップ] 席 ${member.name}: tmux session 生存中`); continue }
  if (!Array.isArray(member.roles) || member.roles.length === 0) { missingRoles.push(member.name); continue }
  relaunch.push({
    name: member.name, roles: member.roles.join(','), harness,
    model: member.model ?? null, effort: member.effort ?? null, mission: member.mission ?? null,
  })
}
if (missingRoles.length) {
  throw new Error(`RESUME_MEMBER_ROLES_MISSING: 役割の無い member は再起動できない: ${missingRoles.join(', ')}。`
    + 'launch-seat.sh --roles で個別に立て直すか、member 行を整備すること')
}
writeFileSync(process.env.RESUME_SEATS_FILE, JSON.stringify(relaunch) + '\n')
console.log(`[実施] 再起動対象の抽出: ${relaunch.length} 席（${relaunch.map(s => s.name).join(', ') || 'なし'}）`)
NODE

# Phase B: 席の再起動（credential 再生成・本人性再記録は launch-seat.sh が持つ）。
# 受け渡しは TSV（mission に tab を含む member は台帳整備の対象であり、ここでは想定しない）
while IFS=$'\t' read -r name roles harness model effort mission; do
  [ -n "$name" ] || continue
  argv=("$proj" "$name" --roles "$roles" --harness "$harness")
  [ -n "$model" ] && argv+=(--model "$model")
  [ -n "$effort" ] && argv+=(--effort "$effort")
  [ -n "$mission" ] && argv+=(--mission "$mission")
  echo "[実施] 席の再起動: $name（roles=$roles harness=$harness${model:+ model=$model}${effort:+ effort=$effort}）"
  env -u PEERTABLE_POST_TOKEN "$script_dir/launch-seat.sh" "${argv[@]}"
done < <(node -e '
  const seats = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  for (const s of seats) console.log([s.name, s.roles, s.harness, s.model ?? "", s.effort ?? "", s.mission ?? ""].join("\t"))
' "$seats_file")
rm -f "$seats_file"

# Phase C: runtime を一回の入口で現行版へ収束
"$script_dir/ensure-project-runtime.sh" "$proj"

# Phase D: fresh heartbeat の読み戻しと probe DM の配送 receipt 確認
RESUME_PROJ="$proj" RESUME_PROBE="$probe" RESUME_SCRIPT_DIR="$script_dir" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const proj = process.env.RESUME_PROJ
const { room, server_url: url } = JSON.parse(readFileSync(join(proj, '.team', 'setup-state.json'), 'utf8'))
const api = p => `${url}/api/${encodeURIComponent(room)}/${p}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

// launch-seat.sh 直後の席（tmux session が居る非親 member）が対象
const { resolvePostToken } = await import(pathToFileURL(join(process.env.RESUME_SCRIPT_DIR, 'seat-usage.mjs')))

// 6. fresh heartbeat の読み戻し（seat-status bridge 心拍 30 秒 + 判定余裕）
const deadline = Date.now() + 90_000
let pendingSeats = []
for (;;) {
  const { members, bridges } = await (await fetch(api('members'))).json()
  const seats = members.filter(m => m.delivery?.kind !== 'parent_watch' && (m.harness ?? m.vendor) && m.observe?.tmux_target)
  if (seats.length === 0) {
    console.log('[スキップ] fresh heartbeat 読み戻し（観測対象の席なし）')
    break
  }
  pendingSeats = seats.filter(m => m.status_reason !== 'fresh')
  if (pendingSeats.length === 0) {
    console.log(`[実施] fresh heartbeat 読み戻し: ${seats.length} 席すべて fresh`)
    break
  }
  if (Date.now() > deadline) {
    console.error(`RESUME_HEARTBEAT_STALE: fresh にならない席: ${pendingSeats.map(m => `${m.name}(${m.status_reason})`).join(', ') || '（席なし）'}`
      + `（bridges: seat_status=${bridges?.seat_status?.state} wakeup=${bridges?.wakeup?.state}）`)
    process.exit(1)
  }
  await sleep(3000)
}

// 7. probe DM の配送 receipt 確認
if (process.env.RESUME_PROBE !== 'true') {
  console.log('[スキップ] probe DM（--no-probe 指定）')
  process.exit(0)
}
const token = resolvePostToken(process.env)
const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) }
const { members } = await (await fetch(api('members'))).json()
const targets = members.filter(m => m.delivery?.kind !== 'parent_watch' && (m.harness ?? m.vendor) && m.observe?.tmux_target).map(m => m.name)
if (!targets.length) { console.log('[スキップ] probe DM（配達対象の席なし）'); process.exit(0) }
const res = await fetch(api('messages'), {
  method: 'POST', headers,
  body: JSON.stringify({ from: 'resume', to: targets.length === 1 ? targets[0] : targets,
    body: '[resume-probe] 配達経路の確認。応答不要・読み流してよい。' }),
})
const saved = await res.json()
if (!res.ok) { console.error(`RESUME_PROBE_POST_FAILED: ${JSON.stringify(saved)}`); process.exit(1) }
console.log(`[実施] probe DM 投稿: seq ${saved.seq} → ${targets.join(', ')}`)
const probeDeadline = Date.now() + 120_000
for (;;) {
  const { delivery } = await (await fetch(api(`deliveries?seq=${saved.seq}`))).json()
  const undelivered = targets.filter(t => delivery?.[t]?.state !== 'delivered')
  if (undelivered.length === 0) {
    console.log('[実施] probe DM の配送 receipt: 全席 delivered')
    break
  }
  if (Date.now() > probeDeadline) {
    console.error(`RESUME_PROBE_UNDELIVERED: delivered にならない席: ${undelivered.map(t => `${t}=${delivery?.[t]?.state ?? 'unknown'}${delivery?.[t]?.reason ? `(${delivery[t].reason})` : ''}`).join(', ')}`
      + '（Grok 席は idle 待ちで遅れることがある。.team/wakeup-bridge.log を確認すること）')
    process.exit(1)
  }
  await sleep(3000)
}
console.log('resume 完了。親の再着卓（parent-join / 番犬）は SKILL.md「親の再着卓」の手順で別途行うこと')
NODE
