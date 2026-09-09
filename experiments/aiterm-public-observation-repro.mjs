#!/usr/bin/env node
// 公開MCPだけを使い、Peertableが必要とする観測契約の有無を記録する。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: 'peertable-public-observation-repro', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: 'aiterm-mcp', env: process.env }))
try {
  const { tools } = await client.listTools()
  const listed = await client.callTool({ name: 'pty_list', arguments: {} })
  const diagnostics = await client.callTool({ name: 'diagnostics', arguments: {} })
  // 一覧の本文（他作業のsession名・command）を保存しない。
  console.log(JSON.stringify({
    schema: 'peertable.aiterm-public-observation-repro.v1',
    tools: tools.map(tool => ({ name: tool.name, outputSchema: tool.outputSchema ?? null })),
    pty_list: { isError: listed.isError === true, structuredContent: listed.structuredContent ?? null },
    diagnostics: diagnostics.structuredContent ?? diagnostics.content,
  }, null, 2))
} finally {
  await client.close()
}
