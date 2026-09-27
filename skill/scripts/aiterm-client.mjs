// Aitermとの接続は公開stdio MCPだけを使う。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync } from 'node:fs'

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

export class AitermClient {
  constructor({ env = process.env } = {}) {
    this.env = env
    this.client = new Client({ name: 'peertable', version })
    this.connected = null
  }
  async connect() {
    this.connected ??= this.client.connect(new StdioClientTransport({ command: 'aiterm-mcp', env: this.env }))
    await this.connected
    return this
  }
  async call(name, args = {}) {
    await this.connect()
    const result = await this.client.callTool({ name, arguments: args })
    if (result.isError) {
      throw Object.assign(new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || `Aiterm ${name} failed`), {
        code: 'PEERTABLE_AITERM_FAILED', tool: name,
      })
    }
    return result
  }
  async structured(name, args, schema) {
    const result = await this.call(name, args)
    if (!result.structuredContent || (schema && result.structuredContent.schema !== schema)) {
      throw Object.assign(new Error(`Aiterm ${name}の公開構造化応答が必要です${schema ? ` (${schema})` : ''}`), {
        code: 'PEERTABLE_AITERM_CONTRACT_UNAVAILABLE', tool: name,
      })
    }
    return result.structuredContent
  }
  async requireUnifiedSend() {
    await this.connect()
    const { tools } = await this.client.listTools()
    const send = tools.find(tool => tool.name === 'pty_send')
    const input = send?.inputSchema?.properties
    const output = send?.outputSchema?.properties
    if (!input?.session_id || !input?.text || !input?.enter ||
        output?.schema?.const !== 'aiterm.pty-send-result.v1' ||
        !['agent_dispatch', 'agent_steer'].every(mode => output?.mode?.enum?.includes(mode))) {
      throw Object.assign(new Error('PEERTABLE_AITERM_CONTRACT_UNAVAILABLE: Aitermを統合pty_send対応版へ更新してください'), {
        code: 'PEERTABLE_AITERM_CONTRACT_UNAVAILABLE', tool: 'pty_send',
      })
    }
  }
  async sessions(envKeys = []) {
    const result = await this.structured('pty_list', { env_keys: envKeys }, 'aiterm.pty-list-result.v1')
    return result.sessions
  }
  async observe(sessionId, cursor) {
    return this.structured('pty_observe', {
      session_id: sessionId, ...(cursor ? { cursor } : {}),
    }, 'aiterm.pty-observe-result.v1')
  }
  async close() { if (this.connected) await this.client.close() }
}
