// 通常CLI各harnessの起動・起動時dialog・自sessionの記録fileの差をここへ閉じ込める。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const posixQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`

export function resolveCli(harness) {
  const name = { claude: 'claude', codex: 'codex' }[harness]
  if (!name) throw Object.assign(new Error(`未対応のharnessです: ${harness}`), { code: 'ACCEPTANCE_HARNESS_UNSUPPORTED' })
  const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0]
  const version = execFileSync(found, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/u)[0]
  return { executable: found, version }
}

// 通常起動のargvへ足すのは、試験roomのtoken参照先をMCPへ渡す指定と、無人実行でCLI更新を促さない指定だけ(session層)。
export function launchLine(harness, { project, tokenFile, model }) {
  const extra = harness === 'codex' ? ['-c', 'mcp_servers.peertable_parent.env_vars=["PEERTABLE_TOKEN_SOURCE_FILE"]', '-c', 'check_for_update_on_startup=false'] : []
  if (model) extra.push(harness === 'codex' ? '-m' : '--model', model)
  if (process.platform === 'win32') return `Set-Location -LiteralPath ${psQuote(project)}; $env:PEERTABLE_TOKEN_SOURCE_FILE = ${psQuote(tokenFile)}; & ${harness} ${extra.map(psQuote).join(' ')}`
  return `cd ${posixQuote(project)} && PEERTABLE_TOKEN_SOURCE_FILE=${posixQuote(tokenFile)} exec ${harness} ${extra.map(posixQuote).join(' ')}`
}
export const isolation = harness => ({
  home: 'normal', auth: 'normal', room: 'local_private_room_server', token: 'PEERTABLE_TOKEN_SOURCE_FILE→project .team/credentials (標準seat-credential経路)',
  session_args: harness === 'codex' ? ['-c mcp_servers.peertable_parent.env_vars=["PEERTABLE_TOKEN_SOURCE_FILE"]', '-c check_for_update_on_startup=false'] : [],
  folder_trust: harness === 'codex' ? '起動dialogで試験dirを信頼し、終了後に公式config/batchWriteでその projects entry だけを削除' : '起動dialogで試験dirを信頼(Claudeのproject履歴に残る)',
})

// 起動直後の公式dialogへ、試験dirを信頼する操作だけを返す。未知のdialogは推測で押さずtimeoutで止める。
export function startupAction(harness, screen) {
  if (harness === 'claude') {
    // 既定選択は「No, exit」。明示的に「Yes, I trust this folder」へ移して確定する。
    if (/Quick safety check|Yes, I trust this folder/u.test(screen)) return { keys: ['Down', 'Enter'], reason: 'claude_folder_trust' }
    // 初回のChrome拡張通知。既定選択の「No, keep browser tools off」だけを確定し、既存の利用設定を変えない。
    if (/Claude in Chrome extension detected/u.test(screen) && /❯\s*No, keep browser tools off/u.test(screen)) return { keys: ['Enter'], reason: 'claude_chrome_notice_keep_off' }
    if (/Claude Code v\d/u.test(screen) && /^\s*❯\s/mu.test(screen)) return { ready: true }
    return null
  }
  if (/Update available/u.test(screen)) return { blocked: 'codex_update_prompt' }
  if (/Do you trust the contents of this directory/u.test(screen) && /›\s*1\. Yes, continue/u.test(screen)) return { keys: ['Enter'], reason: 'codex_directory_trust' }
  // codex-cli 0.158の文言。
  if (/Trust this folder\?/u.test(screen) && /›\s*1\. Trust and continue/u.test(screen)) return { keys: ['Enter'], reason: 'codex_directory_trust' }
  if (/OpenAI Codex \(v/u.test(screen) && /^\s*›\s/mu.test(screen) && !/Press enter to continue/u.test(screen)) return { ready: true }
  return null
}

// 自sessionの記録fileだけを名前で特定する。他会話の中身は読まない。
export function transcriptPath(harness, session) {
  if (harness === 'claude') {
    const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
    for (const dir of readdirSync(root)) { const file = join(root, dir, `${session}.jsonl`); if (existsSync(file)) return file }
    return null
  }
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
  const walk = dir => {
    for (const name of readdirSync(dir).sort().reverse()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { const hit = walk(path); if (hit) return hit }
      else if (name.startsWith('rollout-') && name.endsWith(`${session}.jsonl`)) return path
    }
    return null
  }
  return existsSync(root) ? walk(root) : null
}

// XML 1.0の定義済み実体と数値文字参照だけを復号する。それ以外の & は符号化違反としてそのまま残し、照合で不一致にする。
export const decodeXmlText = text => text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu, (_, name) => name[0] === '#' ? String.fromCodePoint(name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[name])
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? part.content ?? (typeof part === 'string' ? part : '')).map(textOf).join('') : content && typeof content === 'object' ? textOf(content.text ?? content.content ?? '') : ''

// JSONLを行順に読む。改行で終わった行は確定行で、JSONでなければtyped errorで止める。
// 改行の無い末尾はharnessが追記中の未確定部分なので読まず、pending_tailとして返す。
export function readJsonl(text, file) {
  const lines = text.split('\n'), tail = lines.pop()
  const rows = lines.map((line, order) => {
    try { return { order, row: JSON.parse(line) } }
    catch { throw Object.assign(new Error(`${file}:${order + 1} が確定行なのにJSONではありません`), { code: 'ACCEPTANCE_TRANSCRIPT_CORRUPT', line: order + 1 }) }
  })
  return { rows, pending_tail: tail.length }
}

// 記録を行順に読み、親へ届いた本文(injections)と親の返答(replies)をturn識別子付きで返す。
export function readTranscript(harness, file) {
  const { rows, pending_tail } = readJsonl(readFileSync(file, 'utf8'), file)
  const injections = [], replies = [], turns = [], queued = [], toolUses = []
  let turn = null
  for (const { order, row } of rows) {
    if (harness === 'claude') {
      // asyncRewakeのexit2出力は queue-operation(enqueue) を経て、promptId付きのuser entryとして会話へ入る。
      if (row.type === 'queue-operation') { if (String(row.content ?? '').includes('[Peertable room=')) queued.push({ order, operation: row.operation ?? null, at: row.timestamp ?? null, text: row.content }); continue }
      if (row.type === 'user' && !row.isMeta && !row.toolUseResult) {
        turn = row.promptId ?? null
        if (turn && !turns.includes(turn)) turns.push(turn)
        const text = textOf(row.message?.content ?? '')
        if (text.includes('[Peertable room=')) injections.push({ order, session: row.sessionId, turn_id: row.promptId ?? null, entry_uuid: row.uuid, entry_type: 'user', hook: /hook blocking error from command "([^"]+)"/u.exec(text)?.[1] ?? null, text })
      }
      if (row.type === 'assistant') {
        const parts = row.message?.content ?? []
        for (const part of parts) if (part.type === 'tool_use') toolUses.push({ order, session: row.sessionId, turn_id: turn, id: part.id, name: part.name })
        const said = textOf(parts.filter(part => part.type === 'text'))
        if (said) replies.push({ order, session: row.sessionId, turn_id: turn, entry_uuid: row.uuid, text: said })
      }
      continue
    }
    // Codex rollout: turnはtask_started/turn_context。会話へ入った入力と返答は response_item の message だけを数える。
    // Stop/PostToolUse hookの本文は <hook_prompt hook_run_id="stop:..."> で包まれ、公式queue由来のidle配送は包まれない。
    const payload = row.payload ?? {}
    if (row.type === 'turn_context' || (row.type === 'event_msg' && ['task_started', 'turn_started'].includes(payload.type))) { turn = payload.turn_id ?? turn; if (turn && !turns.includes(turn)) turns.push(turn) }
    if (row.type !== 'response_item') continue
    if (payload.type === 'message' && payload.role === 'user') {
      const raw = textOf(payload.content)
      if (!raw.includes('[Peertable room=')) continue
      // Codexはhook出力を <hook_prompt> 要素へ入れ、本文をXML文字参照で符号化する。要素の中身だけを復号し、生textも残す。
      const wrapped = /^<hook_prompt hook_run_id="([^"]*)">([\s\S]*)<\/hook_prompt>$/u.exec(raw)
      const text = wrapped ? decodeXmlText(wrapped[2]) : raw
      injections.push({ order, session: null, turn_id: turn, entry_type: 'response_item:message:user', role: 'user', hook: wrapped ? wrapped[1].split(':')[0] : null, encoding: wrapped ? 'codex_hook_prompt_xml_text' : 'none', raw_text: raw, text })
    }
    if (payload.type === 'message' && payload.role === 'assistant') replies.push({ order, session: null, turn_id: turn, text: textOf(payload.content) })
    if (['function_call', 'custom_tool_call'].includes(payload.type)) toolUses.push({ order, session: null, turn_id: turn, id: payload.call_id ?? null, name: payload.name ?? null })
    if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) toolUses.push({ order, session: null, turn_id: turn, id: payload.call_id ?? null, name: 'output', output: textOf(payload.output ?? '') })
  }
  return { injections, replies, turns, queued, toolUses, rows: rows.length, pending_tail }
}
