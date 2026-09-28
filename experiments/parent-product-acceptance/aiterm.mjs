// 通常CLIの対話PTYはAitermの公開MCP(stdio)だけで開く。tmux/psmuxへ直接依存しない。
// 結果は公式のstructuredContentだけを読み、人間向けtextは解釈しない。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { checkCancellation, closeOwnedChild } from './scenarios-cancellation.mjs'

const typed = (code, message) => Object.assign(new Error(message), { code })

export async function openAiterm({ executable = process.env.PEERTABLE_ACCEPTANCE_AITERM ?? 'aiterm-mcp', args = [], signal } = {}) {
  checkCancellation(signal)
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const pending = new Map()
  let seq = 0, stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }; pending.clear() }
  child.on('error', fail)
  child.on('exit', code => fail(typed('ACCEPTANCE_AITERM_EXITED', `aiterm-mcpが終了しました code=${code} ${stderr}`)))
  createInterface({ input: child.stdout }).on('line', line => {
    let row
    try { row = JSON.parse(line) } catch { return fail(typed('ACCEPTANCE_AITERM_PROTOCOL', `aiterm-mcpのstdoutがJSON-RPCではありません: ${line.slice(0, 200)}`)) }
    const item = pending.get(row.id)
    if (!item) return
    pending.delete(row.id)
    clearTimeout(item.timer)
    row.error ? item.reject(typed('ACCEPTANCE_AITERM_RPC', JSON.stringify(row.error))) : item.resolve(row.result)
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(typed('ACCEPTANCE_AITERM_RPC_TIMEOUT', `${method}の公式応答が60秒以内にありません`)) }, 60000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  // session作成前の初期化だけは中断でstdioを閉じられる。session操作の応答は所有名を保持して完了を待つ。
  let initializationCleanup
  const abortInitialize = () => { child.stdin.end(); initializationCleanup = closeOwnedChild(child); initializationCleanup.catch(fail) }
  signal?.addEventListener('abort', abortInitialize, { once: true })
  try { await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'peertable_parent_acceptance', version: '1' } }); checkCancellation(signal) }
  catch (error) { fail(error); await (initializationCleanup ?? closeOwnedChild(child)); checkCancellation(signal); throw error }
  finally { signal?.removeEventListener('abort', abortInitialize) }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (name, args) => {
    const result = await request('tools/call', { name, arguments: args })
    const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (result.isError) throw typed('ACCEPTANCE_AITERM_TOOL', `${name}: ${text}`)
    return result.structuredContent ?? null
  }
  // 宣言済みschemaを持つtoolは、そのschema名のstructuredContentが無ければtyped errorにする。
  const structured = async (name, args, schema) => {
    const value = await call(name, args)
    if (value?.schema !== schema) throw typed('ACCEPTANCE_AITERM_STRUCTURED_MISSING', `${name}が${schema}を返しません`)
    return value
  }
  const observe = session_id => structured('pty_observe', { session_id }, 'aiterm.pty-observe-result.v1')
  return {
    call,
    observe,
    // pty_openは出力schemaを宣言していない。指定したnameのsessionを公式pty_observeのstructured結果で確認する。
    async open(name, shell) {
      await call('pty_open', { name, ...(shell ? { shell } : {}) })
      const seen = await observe(name)
      if (seen.session_id !== name || seen.exists !== true) throw typed('ACCEPTANCE_AITERM_SESSION_ID_MISSING', `pty_open後にsession ${name} をpty_observeで確認できません`)
      return name
    },
    send: (session_id, text, enter = true) => call('pty_send', { session_id, text, enter }),
    key: (session_id, key) => call('pty_key', { session_id, key }),
    screen: async session_id => (await structured('pty_read', { session_id, screen: true, raw: true }, 'aiterm.pty-read-result.v1')).text,
    async close(session_id) {
      const closed = await structured('pty_close', { session_id }, 'aiterm.pty-close-result.v1')
      if (closed.session_id !== session_id || !['closed', 'already_closed'].includes(closed.outcome)) throw typed('ACCEPTANCE_AITERM_CLOSE', `pty_closeの結果が不正です: ${JSON.stringify(closed)}`)
      return closed
    },
    async end() { child.stdin.end(); await closeOwnedChild(child) },
  }
}
