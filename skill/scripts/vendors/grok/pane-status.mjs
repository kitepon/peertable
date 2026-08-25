/** Grok Build TUI固有のpane状態を返す。判定不能ならnull。 */
export function classifyGrokPaneTail(tail) {
  if (typeof tail !== 'string') return null

  if (isGrokPrivacyBanner(tail)) return 'blocked'

  // 完了後も `stop [hooks: 1/3]` はステータス行へ残る。入力欄が戻った
  // `Worked for ...` 行を先にidle扱いし、配達を永久保留しない。
  if (/Worked for\s+\d+(?:m\d+)?s[\s\S]*?stop\s+\[hooks:\s*\d+\/\d+\]/u.test(tail)) return 'idle'

  if (tail.includes('Waiting for response') || tail.includes('Responding…') || tail.includes('Responding...')) return 'busy'
  if (tail.includes('[stop]')) return 'busy'
  if (/\[hooks:\s*\d+\/\d+\]/u.test(tail)) return 'busy'
  return null
}

/** Grok TUI の SpaceXAI coding-data バナー。 */
export function isGrokPrivacyBanner(tail) {
  return typeof tail === 'string'
    && tail.includes('Help improve Grok')
    && tail.includes('[Opt out]')
    && tail.includes('[Opt in]')
}
