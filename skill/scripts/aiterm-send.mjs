#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [sessionId, promptFile] = process.argv.slice(2)
if (!sessionId || !promptFile) throw new Error('SEAT_AITERM_SEND_ARGS_INVALID')
const prompt = readFileSync(promptFile, 'utf8')
const client = new Client({ name: 'peertable-seat-send', version: '0.8.21' })
await client.connect(new StdioClientTransport({ command: 'aiterm-mcp', env: process.env }))
const result = await client.callTool({
  name: 'pty_send',
  arguments: { session_id: sessionId, text: prompt, enter: true },
})
await client.close()
if (result.isError) throw new Error(result.content?.[0]?.text || 'SEAT_AITERM_SEND_FAILED')
const receipt = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')
if (receipt?.schema !== 'aiterm.pty-send-result.v1' || receipt.session_id !== sessionId
  || receipt.mode !== 'agent_dispatch' || receipt.submit_residue === true) {
  throw new Error('SEAT_AITERM_SEND_RECEIPT_INVALID')
}
process.stdout.write(`${JSON.stringify(receipt)}\n`)
