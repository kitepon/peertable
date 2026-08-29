/** Grok Build TUI固有のpane状態を返す。判定不能ならnull。 */
export function classifyGrokPaneTail(tail) {
  if (typeof tail !== 'string') return null

  if (isGrokPrivacyBanner(tail)) return 'blocked'

  // Grok Build は通信失敗後も `Waiting for response` と `[stop]` を画面へ残し、
  // 再試行中のように見せる。この状態を busy にすると「モデルが仕事を進めている」
  // アクティブランプが点き続けるため、既知の接続失敗を先に blocked と判定する。
  if (tail.includes('Connection failed — reqwest error')
    || tail.includes('Connection failed - reqwest error')
    || tail.includes('Check your network and try again.')) return 'blocked'

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
