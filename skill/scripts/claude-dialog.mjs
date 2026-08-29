#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function keysForClaudeMcpPane(screen) {
  const text = String(screen ?? '')
  if (text.includes('New MCP server found in this project: room')) {
    return { kind: 'single-mcp-consent', keys: ['Down', 'Enter'] }
  }
  if (/new MCP servers found in this project/iu.test(text) && text.includes('Enable selected')) {
    const selected = text.split(/\r?\n/u).filter(line => /\[✔\]/u.test(line))
    if (!selected.some(line => /\broom\b/u.test(line))) return null
    return { kind: 'multi-mcp-consent', keys: [...selected.map(() => 'Down'), 'Enter'] }
  }
  return null
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  process.stdout.write(`${JSON.stringify(keysForClaudeMcpPane(Buffer.concat(chunks).toString('utf8')))}\n`)
}
