#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const spec = () => JSON.parse(readFileSync(process.env.PEERTABLE_TEST_AITERM_SPEC, 'utf8'))
const schema = (name, properties = {}) => ({ name, inputSchema: { type: 'object', properties }, outputSchema: { type: 'object', properties: { schema: { const: 'aiterm.pty-send-result.v1' }, mode: { enum: ['sent', 'agent_dispatch', 'agent_steer'] } } } })
const server = new Server({ name: 'aiterm-fixture', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: spec().oldApi ? [] : [schema('pty_send', { session_id: {}, text: {}, enter: {} })] }))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const { name, arguments: args } = params
  if (name === 'pty_observe') return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', exists: true, harness_alive: true, state: spec().state ?? 'idle', reason: spec().reason ?? null }, content: [] }
  if (name === 'agent_approval') return { structuredContent: { schema: 'aiterm.agent-approval-result.v1', status: 'none' }, content: [] }
  if (name !== 'pty_send') return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] }
  appendFileSync(process.env.PEERTABLE_TEST_AITERM_CALLS, JSON.stringify(args) + '\n')
  const current = spec()
  if (current.breakStateOnSend) {
    const path = process.env.PEERTABLE_TEST_DELIVERY_STATE
    renameSync(path, `${path}.saved`)
    mkdirSync(path)
  }
  if (current.error) return { isError: true, content: [{ type: 'text', text: `aiterm: ${current.error}` }] }
  const mode = current.mode ?? (current.state === 'busy' ? 'agent_steer' : 'agent_dispatch')
  return { structuredContent: {
    schema: 'aiterm.pty-send-result.v1', mode, session_id: args.session_id,
    event_cursor: mode === 'agent_dispatch' ? 1 : null, wait_process: null,
    launch_id: 'fixture', vendor: 'codex', harness: 'codex-cli',
    submit_residue: current.residue ?? false,
  }, content: [] }
})
await server.connect(new StdioServerTransport())
