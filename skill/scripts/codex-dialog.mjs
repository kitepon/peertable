#!/usr/bin/env node
// Codex TUI の既知ダイアログ → 送るキー。画面文言だけで判定する。未知の確認は通さない。
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const MCP_ALLOW_NEEDLE = 'Allow the room MCP server to run tool'
export const MCP_ALWAYS_ALLOW = 'Always allow'
export const COMMAND_APPROVAL_NEEDLE = 'Would you like to run the following command?'
export const COMMAND_APPROVAL_DONT_ASK = "don't ask again"

export function keysForCodexPane(screen) {
  const text = String(screen ?? '')
  if (text.includes(MCP_ALLOW_NEEDLE) && text.includes(MCP_ALWAYS_ALLOW)) {
    return { kind: 'mcp-allow', keys: ['Down', 'Down', 'Enter'] }
  }
  if (text.includes(COMMAND_APPROVAL_NEEDLE) && text.toLowerCase().includes(COMMAND_APPROVAL_DONT_ASK)) {
    return { kind: 'command-approval', keys: ['Down', 'Enter'] }
  }
  if (text.includes('Hooks need review')) {
    return { kind: 'hooks', keys: ['Down', 'Enter'] }
  }
  if (text.includes('Update now')) {
    return { kind: 'update', keys: ['Down', 'Enter'] }
  }
  if (text.includes('Yes, continue') && text.includes('Do you trust the contents of this directory')) {
    return { kind: 'trust', keys: ['Enter'] }
  }
  return null
}

export function blocksCodexReady(screen) {
  const kind = keysForCodexPane(screen)?.kind
  return kind === 'mcp-allow' || kind === 'command-approval'
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const screen = Buffer.concat(chunks).toString('utf8')
  const action = keysForCodexPane(screen)
  if (process.argv.includes('--ready-ok')) {
    process.exit(blocksCodexReady(screen) ? 2 : 0)
  }
  if (process.argv.includes('--keys')) {
    if (action) process.stdout.write(`${action.keys.join('\n')}\n`)
    process.exit(0)
  }
  process.stdout.write(`${JSON.stringify(action)}\n`)
}
