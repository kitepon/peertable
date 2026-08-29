const bytes = text => Buffer.byteLength(text, 'utf8')

export function truncateUtf8(text, maxBytes) {
  if (bytes(text) <= maxBytes) return text
  const suffix = '…'
  let used = bytes(suffix)
  let out = ''
  for (const cp of text) {
    const size = bytes(cp)
    if (used + size > maxBytes) break
    out += cp
    used += size
  }
  return `${out}${suffix}`
}

export function boundedUnread(messages, relevant, formatter, maxBytes = 12_000) {
  const relevantMessages = messages.filter(relevant)
  const rendered = []
  let used = 0
  for (const message of relevantMessages) {
    const separator = rendered.length ? 1 : 0
    let item = formatter(message)
    if (rendered.length === 0 && bytes(item) > maxBytes) item = truncateUtf8(item, maxBytes)
    const size = bytes(item) + separator
    if (used + size > maxBytes) break
    rendered.push({ message, text: item })
    used += size
  }
  const omitted = relevantMessages.length - rendered.length
  const lastIncludedSeq = rendered.at(-1)?.message?.seq ?? null
  const consumedSeq = omitted === 0
    ? (messages.at(-1)?.seq ?? null)
    : lastIncludedSeq
  const tail = omitted > 0 ? `\n[未読残り ${omitted} 件。read_unreadを再実行]` : ''
  return { text: `${rendered.map(item => item.text).join('\n')}${tail}`, omitted, consumedSeq }
}

export function boundedRecent(messages, formatter, count = 20, maxBytes = 12_000) {
  const requested = Math.max(1, Math.min(20, Number.isFinite(Number(count)) ? Math.trunc(Number(count)) : 20))
  const selected = messages.slice(-requested)
  const rendered = []
  let used = 0
  for (let index = selected.length - 1; index >= 0; index--) {
    let item = formatter(selected[index])
    if (rendered.length === 0 && bytes(item) > maxBytes) item = truncateUtf8(item, maxBytes)
    const size = bytes(item) + (rendered.length ? 1 : 0)
    if (used + size > maxBytes) break
    rendered.unshift(item)
    used += size
  }
  const omitted = selected.length - rendered.length
  const prefix = omitted > 0 ? `[古い ${omitted} 件を出力上限のため省略]\n` : ''
  return { text: `${prefix}${rendered.join('\n')}`, omitted, requested }
}
