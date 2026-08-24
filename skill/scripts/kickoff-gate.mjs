#!/usr/bin/env node
// 円卓開始ゲート（決定104）。kickoff を「依頼済み」と扱ってよいかを機械判定する。
// 3条件（①対象席の実効稼働状態が fresh ②kickoff message の delivered receipt ③対象席の引受発言）が
// 全席で成立するまで pending。親の推測・経過時間・room 保存成功による稼働判定を置き換える。
//
// usage: kickoff-gate.mjs <project_dir> --seq <kickoff_seq> --seats <a,b,c> [--ack-regex <re>] [--json]
// 終了コード: 0 = active / 3 = pending / 1 = 判定不能（room へ到達できない等）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const proj = args[0]
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const seq = Number(opt('--seq'))
const seats = (opt('--seats') ?? '').split(',').map(s => s.trim()).filter(Boolean)
const ackRe = new RegExp(opt('--ack-regex') ?? '引受|着手|claim', 'iu')
const asJson = args.includes('--json')
if (!proj || !Number.isSafeInteger(seq) || seq <= 0 || seats.length === 0) {
  console.error('usage: kickoff-gate.mjs <project_dir> --seq <kickoff_seq> --seats <a,b,c> [--ack-regex <re>] [--json]')
  process.exit(1)
}

const { room, server_url: url } = JSON.parse(readFileSync(join(proj, '.team', 'setup-state.json'), 'utf8'))
const api = p => `${url}/api/${encodeURIComponent(room)}/${p}`
const get = async (p) => {
  const res = await fetch(api(p))
  if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`)
  return res.json()
}

let membersBody, deliveryBody, messagesBody
try {
  ;[membersBody, deliveryBody, messagesBody] = await Promise.all([
    get('members'), get(`deliveries?seq=${seq}`), get(`messages?since=${seq}`),
  ])
} catch (error) {
  console.error(`KICKOFF_GATE_UNREACHABLE: ${error.message}`)
  process.exit(1)
}
const members = new Map(membersBody.members.map(m => [m.name, m]))
if (membersBody.members.length && membersBody.members[0].status_effective === undefined) {
  console.error('KICKOFF_GATE_SERVER_TOO_OLD: server が実効稼働状態を返さない版。判定できない')
  process.exit(1)
}

const report = {}
let allPass = true
for (const seat of seats) {
  const member = members.get(seat)
  const fresh = member?.status_reason === 'fresh' && member.status_effective !== 'dead'
  const delivery = deliveryBody.delivery?.[seat]
  const delivered = delivery?.state === 'delivered'
  const ack = messagesBody.messages.find(m => m.from === seat && m.seq > seq && ackRe.test(m.body ?? ''))
  const pass = fresh && delivered && Boolean(ack)
  allPass = allPass && pass
  report[seat] = {
    pass,
    status: member ? { effective: member.status_effective, reason: member.status_reason } : { effective: null, reason: 'member_not_found' },
    delivery: delivery ?? { state: 'unknown' },
    ack: ack ? { seq: ack.seq, body: String(ack.body).slice(0, 80) } : null,
  }
}

const state = allPass ? 'active' : 'pending'
if (asJson) {
  console.log(JSON.stringify({ schema: 'peertable.kickoff_gate.v1', room, kickoff_seq: seq, state, seats: report }))
} else {
  console.log(`kickoff-gate: ${state}（room=${room} kickoff seq=${seq}）`)
  for (const [seat, r] of Object.entries(report)) {
    const parts = [
      `状態=${r.status.effective ?? '不在'}(${r.status.reason})`,
      `配達=${r.delivery.state}${r.delivery.reason ? `(${r.delivery.reason})` : ''}`,
      `引受=${r.ack ? `seq ${r.ack.seq}` : 'なし'}`,
    ]
    console.log(`  ${r.pass ? 'OK' : 'NG'} ${seat}: ${parts.join(' / ')}`)
  }
  if (state === 'pending') console.log('  3条件が揃うまで円卓taskは依頼済みと扱わないこと（決定104）')
}
process.exit(state === 'active' ? 0 : 3)
