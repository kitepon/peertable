#!/usr/bin/env node
import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isPeertableRoomMcp } from './room-mcp-config.mjs'

const fail = (code, detail) => {
  process.stderr.write(`${JSON.stringify({ schema: 'peertable.managed_room_mcp_remove_result.v1',
    result: 'rejected', code, detail })}\n`)
  process.exit(1)
}

const [project] = process.argv.slice(2)
if (!project) fail('PEERTABLE_MANAGED_MCP_REMOVE_ARGS_INVALID', '<project>')
const file = resolve(project, '.mcp.json')
let stat
try { stat = lstatSync(file) } catch (error) {
  if (error?.code === 'ENOENT') {
    process.stdout.write(`${JSON.stringify({ schema: 'peertable.managed_room_mcp_remove_result.v1',
      result: 'ok', action: 'already-absent' })}\n`)
    process.exit(0)
  }
  fail('PEERTABLE_MANAGED_MCP_REMOVE_UNREADABLE', error.message)
}
if (stat.isSymbolicLink() || !stat.isFile())
  fail('PEERTABLE_MANAGED_MCP_REMOVE_UNSAFE', `${file} がsymlinkまたはregular fileでない`)

let config
try { config = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
  fail('PEERTABLE_MANAGED_MCP_REMOVE_INVALID', `${file}: JSONを読めない: ${error.message}`)
}
if (!config || typeof config !== 'object' || Array.isArray(config)
  || !config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
  fail('PEERTABLE_MANAGED_MCP_REMOVE_INVALID', `${file}: root/mcpServersがobjectでない`)
}
if (config.mcpServers.room === undefined) {
  process.stdout.write(`${JSON.stringify({ schema: 'peertable.managed_room_mcp_remove_result.v1',
    result: 'ok', action: 'room-already-absent' })}\n`)
  process.exit(0)
}
if (!isPeertableRoomMcp(config.mcpServers.room))
  fail('PEERTABLE_MANAGED_MCP_REMOVE_CONFLICT', `${file}: room blockがPeertable所有形でない`)

delete config.mcpServers.room
if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
if (Object.keys(config).length === 0) {
  unlinkSync(file)
  process.stdout.write(`${JSON.stringify({ schema: 'peertable.managed_room_mcp_remove_result.v1',
    result: 'ok', action: 'file-deleted' })}\n`)
  process.exit(0)
}

const temporary = join(dirname(file), `.${basename(file)}.teardown-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
let fd
try {
  fd = openSync(temporary, 'wx', stat.mode & 0o777)
  writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  fsyncSync(fd)
  closeSync(fd)
  fd = undefined
  renameSync(temporary, file)
} catch (error) {
  if (fd !== undefined) closeSync(fd)
  try { unlinkSync(temporary) } catch {}
  fail('PEERTABLE_MANAGED_MCP_REMOVE_FAILED', error.message)
}
process.stdout.write(`${JSON.stringify({ schema: 'peertable.managed_room_mcp_remove_result.v1',
  result: 'ok', action: 'room-removed-file-preserved' })}\n`)
