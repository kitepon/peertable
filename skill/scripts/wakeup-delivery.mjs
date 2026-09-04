import { classifyPaneTail } from './seat-usage.mjs'

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

/**
 * 親は parent-watch が配達する。通常席の TUI 配達から外す。
 * Codex / Grok の observe 欠落は対象外ではない——配達できない故障であり、黙って飛ばさない。
 */
export function isWakeupBridgeTarget(member, options = {}) {
  if (!member || typeof member.name !== 'string' || member.name.length === 0) return false
  if (member.delivery?.kind === 'parent_watch') return false
  // Claude 席は room client の `notifications/claude/channel` で起きる。TUI へ pty_send すると aiterm が
  // 匿名 turn を予約し、Stop を回収しない限り次の配達が「Claude turn が未解決」で拒否される
  // （実測 2026-09-04: 監査席 sakura への 2 通目以降が全部 DELIVERY_FAILED）。bridge の対象にしない。
  if (memberHarness(member) === 'claude') return false
  const parentName = options.parentName
  if (typeof parentName === 'string' && parentName.length > 0 && member.name === parentName) return false
  const observe = member.observe
  const hasPane = Boolean(
    observe
    && typeof observe === 'object'
    && typeof observe.tmux_target === 'string'
    && observe.tmux_target,
  )
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

/** Grok 既定はキュー投入。busy 中に積むと今のターンへ混ざらない。 */
export function shouldDeferGrokWake(harness, tail) {
  if (harness !== 'grok') return false
  if (typeof tail !== 'string') return false
  if (classifyPaneTail(tail) === 'busy') return true
  if (tail.includes('send a message to interrupt')) return true
  return tail.includes('Enter:send now') && /#\d+\s+\[/u.test(tail)
}
