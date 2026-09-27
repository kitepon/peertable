import { seatSessionId } from './seat-session.mjs'

export const BROADCAST_RECIPIENT = 'all'
export const ROOM_UPDATE_FALLBACK =
  'room全体の状況が更新された。room.read_logで部屋を読み、状況を把握して次の行動を判断する。'

/** member素性の正本はharness。旧server応答（vendorだけ）も受ける。 */
export function memberHarness(member) {
  return member?.harness ?? member?.vendor
}

export function collapseWakeBody(body) {
  return String(body ?? '').replace(/\s*\n+\s*/gu, ' / ')
}

export function formatWakeNotice(msg) {
  const audience = Array.isArray(msg.to_names) ? msg.to_names.join(', ') : msg.to
  const body = collapseWakeBody(msg.body)
  if (msg.to === BROADCAST_RECIPIENT) {
    return body
      ? `[Peertable #${msg.seq}] ${msg.from} → ${BROADCAST_RECIPIENT}: ${body}`
      : `[Peertable #${msg.seq}] ${ROOM_UPDATE_FALLBACK}`
  }
  return `[Peertable DM #${msg.seq}] ${msg.from} → ${audience}: ${body}`
}

export function memberDeliveryMode(receipt) {
  if (receipt?.schema !== 'aiterm.pty-send-result.v1' || receipt.submit_residue === true ||
      !['agent_dispatch', 'agent_steer'].includes(receipt.mode)) {
    const code = receipt?.submit_residue === true ? 'DELIVERY_STUCK' : 'PEERTABLE_AITERM_CONTRACT_UNAVAILABLE'
    throw Object.assign(new Error(`${code}: mode=${receipt?.mode ?? 'missing'}`), { code, deliveryUncertain: true })
  }
  return receipt.mode
}

export function deliveryFailureCode(error) {
  const message = String(error?.message ?? '')
  if (/^(?:aiterm: )?STEER_NOT_QUEUED(?:\s|$)/u.test(message)) return 'STEER_NOT_QUEUED'
  if (/^(?:aiterm: )?STEER_STILL_QUEUED(?:\s|$)/u.test(message)) return 'STEER_STILL_QUEUED'
  if (/^(?:aiterm: )?submit_residue=true(?:\s|$)/u.test(message)) return 'DELIVERY_STUCK'
  return typeof error?.code === 'string' ? error.code : 'INJECTION_FAILED'
}

/**
 * 親は parent-watch が配達する。通常席の TUI 配達から外す。
 * Codex / Grok の observe 欠落は対象外ではない——配達できない故障であり、黙って飛ばさない。
 */
export function isWakeupBridgeTarget(member, options = {}) {
  if (!member || typeof member.name !== 'string' || member.name.length === 0) return false
  if (member.delivery?.kind === 'parent_watch') return false
  // Claude 席も bridge の対象にする。channel 通知だけでは idle の席が起きない実測がある。
  const parentName = options.parentName
  if (typeof parentName === 'string' && parentName.length > 0 && member.name === parentName) return false
  const hasPane = Boolean(seatSessionId(member))
  if (hasPane) return true
  const harness = memberHarness(member)
  return harness === 'codex' || harness === 'grok'
}

/**
 * 手番の無い待機自己DMは起こさない。
 * 実測 2026-08-20: 監査席が `[次の行動] 変化なし／待機継続` を自分へ送り、
 * wakeup-bridge がそれを次ターンとして注入し、18秒周期で無限自己DMになった。
 * 次の仕事がある自己DM（監査待ちを含む）は起こす。
 */
export function isIdleSelfWake(msg) {
  const from = msg?.from
  if (typeof from !== 'string' || from.length === 0) return false
  const recipients = Array.isArray(msg.to_names)
    ? msg.to_names
    : typeof msg.to === 'string'
      ? [msg.to]
      : []
  if (recipients.includes(BROADCAST_RECIPIENT)) return false
  if (!recipients.includes(from)) return false
  const body = String(msg.body ?? '')
  if (!body.startsWith('[次の行動]')) return false
  return /変化なし|待機継続|黙って待機/.test(body)
}
