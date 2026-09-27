#!/usr/bin/env node
// Cursor Agent CLIが読むproject設定へ、Peertable所有のroom MCPだけを追加・撤去する。
import {
  existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addExclude, removeExclude } from './project-scaffold.mjs'
import { expectedRoomMcp, isExpectedRoomMcp } from './room-mcp-config.mjs'

const markerName = 'cursor-room-mcp.managed.json'
const excludeRule = '/.cursor/mcp.json'

export function expectedCursorRoomMcp(peertableRepo) {
  const keys = [
    'PEERTABLE_URL', 'PEERTABLE_ROOM', 'PEERTABLE_MEMBER', 'PEERTABLE_CREDENTIAL_FILE',
    'PEERTABLE_HARNESS', 'PEERTABLE_VENDOR', 'PEERTABLE_MODEL', 'PEERTABLE_EFFORT',
    'PEERTABLE_ROLE', 'PEERTABLE_ROLES', 'PEERTABLE_MISSION', 'AITERM_SESSION_ID',
  ]
  return { ...expectedRoomMcp(peertableRepo), env: Object.fromEntries(keys.map(key => [key, '${env:' + key + '}'])) }
}

function isExpectedCursorRoomMcp(current, expected) {
  return Boolean(current && typeof current === 'object' && !Array.isArray(current)
    && Object.keys(current).sort().join(',') === 'args,command,env'
    && isExpectedRoomMcp({ command: current.command, args: current.args }, expected)
    && current.env && typeof current.env === 'object' && !Array.isArray(current.env)
    && Object.keys(current.env).sort().join(',') === Object.keys(expected.env).sort().join(',')
    && Object.entries(expected.env).every(([key, value]) => current.env[key] === value))
}

const fail = (code, message) => {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}

function readJson(file, code) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { fail(code, `${file} をJSONとして読めません: ${error.message}`) }
}

function atomicWrite(file, value, mode) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', mode)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function regularFile(file, code) {
  if (!existsSync(file)) return false
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code, `${file} は通常ファイルではありません`)
  return true
}

function cursorConfig(project) {
  const directory = join(project, '.cursor')
  if (existsSync(directory)) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SEAT_CURSOR_ROOM_MCP_CONFLICT', '.cursorは通常ディレクトリではありません')
  }
  return { directory, file: join(directory, 'mcp.json'), marker: join(project, '.team', markerName) }
}

function readMarker(file) {
  if (!existsSync(file)) return null
  const marker = readJson(file, 'SEAT_CURSOR_ROOM_MCP_OWNERSHIP_INVALID')
  if (!marker || marker.schema !== 'peertable.cursor-room-mcp.v1' || typeof marker.added_exclude !== 'boolean')
    fail('SEAT_CURSOR_ROOM_MCP_OWNERSHIP_INVALID', file)
  return marker
}

function readConfig(file) {
  const exists = regularFile(file, 'SEAT_CURSOR_ROOM_MCP_CONFLICT')
  const config = exists ? readJson(file, 'SEAT_CURSOR_ROOM_MCP_CONFLICT') : {}
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    fail('SEAT_CURSOR_ROOM_MCP_CONFLICT', `${file} の形式が不正です`)
  }
  return { exists, config }
}

export function ensureCursorRoomMcp(project, peertableRepo) {
  project = resolve(project)
  const paths = cursorConfig(project)
  const marker = readMarker(paths.marker)
  const { exists, config } = readConfig(paths.file)
  const expected = expectedCursorRoomMcp(peertableRepo)
  const current = config.mcpServers?.room
  if (current !== undefined) {
    if (isExpectedCursorRoomMcp(current, expected))
      return { schema: 'peertable.cursor-room-mcp.v1', status: marker ? 'ready' : 'preexisting', file: paths.file }
    if (marker && isExpectedRoomMcp(current, expectedRoomMcp(peertableRepo))) {
      config.mcpServers.room = expected
      atomicWrite(paths.file, config, lstatSync(paths.file).mode & 0o777)
      return { schema: 'peertable.cursor-room-mcp.v1', status: 'migrated', file: paths.file }
    }
    fail('SEAT_CURSOR_ROOM_MCP_CONFLICT', '既存のroom MCP定義が異なります')
  }
  if (marker) fail('SEAT_CURSOR_ROOM_MCP_OWNERSHIP_CONFLICT', 'Peertable管理中のroom MCPが変更されています')

  // 所有記録を先に残す。設定の置換が失敗しても、利用者の設定を所有物と誤認しない。
  atomicWrite(paths.marker, { schema: 'peertable.cursor-room-mcp.v1', added_exclude: false }, 0o600)
  try {
    config.mcpServers ??= {}
    config.mcpServers.room = expected
    atomicWrite(paths.file, config, exists ? lstatSync(paths.file).mode & 0o777 : 0o600)
    const addedExclude = addExclude(project, excludeRule)
    atomicWrite(paths.marker, { schema: 'peertable.cursor-room-mcp.v1', added_exclude: addedExclude }, 0o600)
  } catch (error) {
    // 配置前に作った所有記録だけを戻す。設定更新済みならmarkerを残して次回に安全に撤去する。
    if (!existsSync(paths.file)) unlinkSync(paths.marker)
    throw error
  }
  return { schema: 'peertable.cursor-room-mcp.v1', status: 'managed', file: paths.file }
}

export function removeCursorRoomMcp(project, peertableRepo) {
  project = resolve(project)
  const paths = cursorConfig(project)
  const marker = readMarker(paths.marker)
  if (!marker) return { schema: 'peertable.cursor-room-mcp.v1', status: 'absent', file: paths.file }
  const { exists, config } = readConfig(paths.file)
  if (exists) {
    const current = config.mcpServers?.room
    if (!isExpectedCursorRoomMcp(current, expectedCursorRoomMcp(peertableRepo))
        && !isExpectedRoomMcp(current, expectedRoomMcp(peertableRepo)))
      fail('SEAT_CURSOR_ROOM_MCP_OWNERSHIP_CONFLICT', 'Peertable管理中のroom MCPが変更されています')
    delete config.mcpServers.room
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
    if (Object.keys(config).length === 0) {
      unlinkSync(paths.file)
      try { rmdirSync(paths.directory) } catch {}
    } else atomicWrite(paths.file, config, lstatSync(paths.file).mode & 0o777)
  }
  if (marker.added_exclude) removeExclude(project, excludeRule)
  unlinkSync(paths.marker)
  return { schema: 'peertable.cursor-room-mcp.v1', status: 'removed', file: paths.file }
}

const isMain = process.argv[1] && (() => {
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  const [action, project, peertableRepo] = process.argv.slice(2)
  try {
    if (!['ensure', 'remove'].includes(action) || !project || !peertableRepo)
      fail('SEAT_CURSOR_ROOM_MCP_ARGS_INVALID', '<ensure|remove> <project> <peertable_repo>')
    const result = action === 'ensure' ? ensureCursorRoomMcp(project, peertableRepo) : removeCursorRoomMcp(project, peertableRepo)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error.code ?? 'SEAT_CURSOR_ROOM_MCP_FAILED'}: ${error.message}\n`)
    process.exitCode = 1
  }
}
