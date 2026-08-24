#!/usr/bin/env node
// Claude channelsとGrok Buildが読むproject rootのroom MCPを、同じPeertable treeのclientへ束縛する。
import {
  closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { expectedRoomMcp, isExpectedRoomMcp } from './room-mcp-config.mjs'

const fail = (code, message) => {
  process.stderr.write(`${code}: ${message}\n`)
  process.exit(1)
}

const [project, peertableRepo, ownership] = process.argv.slice(2)
if (!project || !peertableRepo || !['managed', 'preexisting'].includes(ownership))
  fail('SEAT_ROOM_MCP_ARGS_INVALID', '<project> <peertable_repo> <managed|preexisting>')

const file = resolve(project, '.mcp.json')
let config
try { config = JSON.parse(readFileSync(file, 'utf8')) } catch {
  fail('SEAT_ROOM_MCP_UNREADABLE', `${file} をJSONとして読めない`)
}
if (!config || typeof config !== 'object' || Array.isArray(config))
  fail('SEAT_ROOM_MCP_INVALID', `${file} のrootがobjectでない`)
const expected = expectedRoomMcp(peertableRepo)
const current = config?.mcpServers?.room
if (isExpectedRoomMcp(current, expected)) process.exit(0)

if (ownership !== 'managed')
  fail('SEAT_ROOM_MCP_STALE', '既存.mcp.jsonのroom serverをcurrent-tree clientへmergeする必要がある')

config.mcpServers ??= {}
config.mcpServers.room = expected
const temporary = join(project, `.mcp.json.${process.pid}.tmp`)
let fd
try {
  const mode = statSync(file).mode & 0o777
  fd = openSync(temporary, 'wx', mode)
  writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  fsyncSync(fd)
  closeSync(fd)
  fd = undefined
  renameSync(temporary, file)
} catch (error) {
  if (fd !== undefined) closeSync(fd)
  try { unlinkSync(temporary) } catch {}
  fail('SEAT_ROOM_MCP_UPDATE_FAILED', error.message)
}
