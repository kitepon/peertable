#!/usr/bin/env node
// Peertable の正規席を Aiterm の公開 agent launcher から起動する境界。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [session_name, harness, model, reasoning_effort, cwd, prompt = ''] = process.argv.slice(2)
if (!session_name || !['claude', 'codex', 'grok'].includes(harness) || !model || !reasoning_effort || !cwd) {
  throw new Error('SEAT_AITERM_LAUNCH_ARGS_INVALID')
}

const client = new Client({ name: 'peertable-seat-launch', version: '0.4.12' })
await client.connect(new StdioClientTransport({ command: 'aiterm-mcp', env: process.env }))
const env_vars = [
  'PEERTABLE_URL', 'PEERTABLE_ROOM', 'PEERTABLE_MEMBER', 'PEERTABLE_CREDENTIAL_FILE',
  'PEERTABLE_HARNESS', 'PEERTABLE_VENDOR', 'PEERTABLE_MODEL', 'PEERTABLE_EFFORT', 'PEERTABLE_ROLE',
  'PEERTABLE_ROLES', 'PEERTABLE_MISSION',
  'PEERTABLE_TMUX_SOCKET',
]
if (process.env.PEERTABLE_PLAN) env_vars.push(
  'PEERTABLE_PLAN', 'LATTICE_CLI', 'LATTICE_TODO_ACTOR_HOST',
  'LATTICE_TODO_ACTOR_SESSION', 'LATTICE_TODO_ACTOR_AGENT',
)
if (harness === 'grok') {
  if (process.env.GROK_HOME) env_vars.push('GROK_HOME')
  env_vars.push('GROK_PRIVACY_NOTICE_ROLLOUT')
}
if (harness === 'codex' && process.env.CODEX_HOME) env_vars.push('CODEX_HOME')
const result = await client.callTool({
  name: `${harness}_agent`,
  arguments: {
    session_name,
    cwd,
    model,
    reasoning_effort,
    env_vars,
    ...(prompt ? { prompt } : {}),
  },
})
await client.close()
if (result.isError) throw new Error(result.content?.[0]?.text ?? 'SEAT_AITERM_LAUNCH_FAILED')
const receipt = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')
if (receipt?.schema !== 'aiterm.agent-launch-result.v1' || receipt.provider !== harness || receipt.session_id !== session_name) {
  throw new Error('SEAT_AITERM_LAUNCH_RECEIPT_INVALID')
}
console.log(JSON.stringify(receipt))
