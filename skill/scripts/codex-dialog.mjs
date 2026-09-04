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
  const lines = text.split(/\r?\n/u).slice(-24)
  const tail = lines.join('\n')
  // scrollbackに残った古いdialogより、現在のbusy表示／通常composerを優先する。
  // active dialog自身の選択肢行（`› 1.`）は通常composerとして数えない。
  const busy = /esc to interrupt/iu.test(tail)
  const idleComposer = lines.some(line => /^\s*›(?:\s*$|\s+(?!\d+\.))/u.test(line))
    && lines.some(line => /gpt-[\w.-]+/iu.test(line) && line.includes('·'))
  if (busy || idleComposer) return null
  // 長いcommand approvalは質問行が24行より上へ押し出される。現在の選択footerが末尾に
  // 在る時だけ全画面を読み、footerが無い通常画面では古いscrollbackを拾わない。
  const activeDialogFooter = /Press enter to confirm or esc to (?:cancel|go back)|enter to submit \| esc to cancel/iu.test(tail)
  const dialogText = activeDialogFooter ? text : tail
  if (dialogText.includes(MCP_ALLOW_NEEDLE) && dialogText.includes(MCP_ALWAYS_ALLOW)) {
    return { kind: 'mcp-allow', keys: ['Down', 'Down', 'Enter'] }
  }
  if (dialogText.includes(COMMAND_APPROVAL_NEEDLE) && dialogText.toLowerCase().includes(COMMAND_APPROVAL_DONT_ASK)) {
    return { kind: 'command-approval', keys: ['Down', 'Enter'] }
  }
  // Codex 0.153: 上限接近時に安いモデルへの切替を勧める modal。モデル配置は 02_models の順位表が決めるので
  // 切り替えず「Keep current model (never show again)」（3 番目）を選ぶ（実測 2026-09-04: mio 席が入力不能に）。
  if (dialogText.includes('Approaching rate limits') && dialogText.includes('Keep current model')) {
    return { kind: 'rate-limit-model-switch', keys: ['Down', 'Down', 'Enter'] }
  }
  if (dialogText.includes('Hooks need review')) {
    return { kind: 'hooks', keys: ['Down', 'Enter'] }
  }
  if (dialogText.includes('Update now')) {
    return { kind: 'update', keys: ['Down', 'Enter'] }
  }
  if (dialogText.includes('Yes, continue') && dialogText.includes('Do you trust the contents of this directory')) {
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
