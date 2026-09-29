// 親への配送はAitermと同じ方式（aiterm-steer-delivery）を使う。ここはPeertableの製品情報と、親の特定だけを持つ。
import { fileURLToPath } from 'node:url'
import * as steer from 'aiterm-steer-delivery'
import { parentHome, failure } from './parent-platform.mjs'

export const parentServerName = 'peertable_parent'
export const PEERTABLE_PROFILE = {
  id: 'peertable',
  display_name: 'Peertable',
  setup_command: 'peertable parent connect',
  codex_steer_command: 'peertable parent connect --target codex',
  mcp_server: parentServerName,
  dispatch_tools: ['parent_join', 'parent_leave'],
  state_root: parentHome,
  config_root: parentHome,
  hooks: { codex: 'peertable-parent-codex-hook.mjs', claude: 'peertable-parent-claude-hook.mjs', cursor: 'peertable-parent-cursor-hook.mjs' },
  codex_client_name: 'peertable_parent_delivery',
  codex_hook_schema: 'peertable.codex-parent-hooks.v1',
  backup_suffix: '.peertable-backup',
  // Claudeの待機はhookの期限（24時間）の手前で終わる。親を一度起こして、turn終了で待機を張り直す。
  channels: { claude_expiry_notice: '[Peertable] 受信の待機を張り直すための通知です。対応は不要です。' },
}
export const entries = {
  codex: fileURLToPath(new URL('./peertable-parent-codex-hook.mjs', import.meta.url)),
  claude: fileURLToPath(new URL('./peertable-parent-claude-hook.mjs', import.meta.url)),
  cursor: fileURLToPath(new URL('./peertable-parent-cursor-hook.mjs', import.meta.url)),
  receive: fileURLToPath(new URL('./peertable-parent-receive.mjs', import.meta.url)),
}

export function clientHarness(client) {
  const name = client?.name ?? ''
  if (name === 'codex-mcp-client') return 'codex'
  if (name === 'claude-code') return 'claude'
  if (name === 'Cursor' || steer.isCursorMcpClient(name)) return 'cursor'
  if (name.startsWith('grok-')) return 'grok'
  throw failure('PARENT_CLIENT_UNSUPPORTED', `未確認のMCP client: ${name}`)
}

/**
 * MCP要求から親を特定する（Aitermと同じ根拠）。Codexは要求の_meta.threadId、Claude CodeはPreToolUse hookの記録と
 * 要求の_meta["claudecode/toolUseId"]、Cursorはhookの登録を確認し、会話への束縛はtool結果の印で行う。
 * Grok等の特定できない親はnullで、背景の受信processだけで受け取る。
 */
export function parentFromRequest(client, meta) {
  const name = client?.name
  const harness = clientHarness(client)
  if (harness === 'codex') return steer.codexParentFromRequest(name, meta)
  if (harness === 'claude') return steer.claudeParentFromRequest(PEERTABLE_PROFILE, name, meta, steer.claudeHookRoot(PEERTABLE_PROFILE))
  if (harness === 'cursor') {
    steer.verifyCursorParent(PEERTABLE_PROFILE, { kind: 'cursor', hook_root: steer.cursorHookRoot(PEERTABLE_PROFILE) })
    return { kind: 'cursor' }
  }
  return null
}

export { steer }
