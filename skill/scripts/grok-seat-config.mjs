#!/usr/bin/env node
// Peertable席のGrokをroom専用にする。GROK_HOMEだけではClaude/Cursor互換源を読むため、
// compatを明示OFFにし、project .mcp.jsonのroom以外もnative高優先設定でdisableする。
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [projectArg, outputArg] = process.argv.slice(2)
if (!projectArg || !outputArg) throw new Error('GROK_SEAT_CONFIG_ARGS_INVALID')
const project = resolve(projectArg)
const output = resolve(outputArg)
const rootMcp = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'))
const servers = rootMcp?.mcpServers
if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !servers.room) {
  throw new Error('GROK_SEAT_ROOM_MCP_MISSING')
}

const disabled = Object.keys(servers).filter(name => name !== 'room').sort((a, b) => a.localeCompare(b, 'en'))
const lines = [
  `disabled_mcp_servers = ${JSON.stringify(disabled)}`,
  '',
  '[ui]',
  'permission_mode = "always-approve"',
  '',
  '[compat.claude]',
  'skills = false',
  'rules = false',
  'agents = false',
  'mcps = false',
  'hooks = false',
  'sessions = false',
  '',
  '[compat.cursor]',
  'skills = false',
  'rules = false',
  'agents = false',
  'mcps = false',
  'hooks = false',
  'sessions = false',
  '',
  '[compat.codex]',
  'sessions = false',
]
mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
const temp = `${output}.${process.pid}.tmp`
writeFileSync(temp, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
chmodSync(temp, 0o600)
renameSync(temp, output)
