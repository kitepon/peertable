#!/usr/bin/env node
// Codexが読むproject設定へ、Peertable所有のroom MCP blockだけを追加・撤去する。
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { repairSplicedBegin } from './codex-seat-toml.mjs'

const fail = (code, message) => {
  process.stderr.write(`${code}: ${message}\n`)
  process.exit(1)
}

const [action, project, peertableRepo] = process.argv.slice(2)
if (!['ensure', 'remove'].includes(action) || !project || !peertableRepo)
  fail('SEAT_CODEX_ROOM_MCP_ARGS_INVALID', '<ensure|remove> <project> <peertable_repo>')

const configDir = resolve(process.env.CODEX_HOME || join(project, '.codex'))
const configFile = join(configDir, 'config.toml')
const startPattern = /^# BEGIN PEERTABLE ROOM MCP added_newline=([01])$/mu
const endMarker = '# END PEERTABLE ROOM MCP'
const roomHeader = /^\s*\[mcp_servers\.room\]\s*$/mu
const seatEnvNames = [
  'PEERTABLE_URL', 'PEERTABLE_ROOM', 'PEERTABLE_MEMBER', 'PEERTABLE_CREDENTIAL_FILE',
  'PEERTABLE_HARNESS', 'PEERTABLE_VENDOR', 'PEERTABLE_MODEL', 'PEERTABLE_EFFORT', 'PEERTABLE_ROLE',
  'PEERTABLE_ROLES', 'PEERTABLE_MISSION',
  'PEERTABLE_PLAN', 'LATTICE_CLI', 'LATTICE_TODO_ACTOR_HOST',
  'LATTICE_TODO_ACTOR_SESSION', 'LATTICE_TODO_ACTOR_AGENT',
]
const requiredSeatEnv = [
  'PEERTABLE_URL', 'PEERTABLE_ROOM', 'PEERTABLE_MEMBER', 'PEERTABLE_CREDENTIAL_FILE',
  'PEERTABLE_HARNESS', 'PEERTABLE_VENDOR', 'PEERTABLE_MODEL', 'PEERTABLE_ROLE', 'PEERTABLE_ROLES',
]

function atomicWrite(file, body, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', mode)
    writeFileSync(fd, body, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    chmodSync(file, mode)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function markerRange(text) {
  const starts = [...text.matchAll(new RegExp(startPattern.source, 'gmu'))]
  const ends = [...text.matchAll(new RegExp(`^${endMarker}$`, 'gmu'))]
  if (starts.length === 0 && ends.length === 0) return null
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index)
    fail('SEAT_CODEX_ROOM_MCP_UNREADABLE', `${configFile} のPeertable block境界が壊れている`)
  let end = ends[0].index + endMarker.length
  if (text[end] === '\n') end += 1
  return { start: starts[0].index, end, addedNewline: starts[0][1] === '1' }
}

function expectedBlock(addedNewline) {
  const client = resolve(peertableRepo, 'room', 'client.mjs')
  const explicitEnv = seatEnvNames
    .filter((name) => process.env[name] !== undefined && process.env[name] !== '')
    .map((name) => `${name} = ${JSON.stringify(process.env[name])}`)
  if (process.env.PATH) explicitEnv.unshift(`PATH = ${JSON.stringify(process.env.PATH)}`)
  return [
    `# BEGIN PEERTABLE ROOM MCP added_newline=${addedNewline ? '1' : '0'}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '[mcp_servers.room]',
    'command = "node"',
    `args = [${JSON.stringify(client)}]`,
    'env_vars = ["TMUX", "TMUX_PANE"]',
    '[mcp_servers.room.env]',
    ...explicitEnv,
    endMarker,
    '',
  ].join('\n')
}

function gitExcludePath() {
  try {
    return execFileSync('git', [
      '-C', project, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude',
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch { return '' }
}

function ensureExclude() {
  const file = gitExcludePath()
  if (!file) return
  const marker = '# peertable:codex-room-mcp'
  const rule = '/.codex/config.toml'
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split(/\r?\n/u).includes(rule)) return
  const prefix = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
  atomicWrite(file, `${prefix}${marker}\n${rule}\n`, existsSync(file) ? statSync(file).mode & 0o777 : 0o644)
}

function removeExclude() {
  const file = gitExcludePath()
  if (!file || !existsSync(file)) return
  const lines = readFileSync(file, 'utf8').split('\n')
  const marker = '# peertable:codex-room-mcp'
  const rule = '/.codex/config.toml'
  const index = lines.findIndex((line, at) => line === marker && lines[at + 1] === rule)
  if (index < 0) return
  lines.splice(index, 2)
  atomicWrite(file, lines.join('\n'), statSync(file).mode & 0o777)
}

try {
  if (action === 'ensure') {
    const missing = requiredSeatEnv.filter((name) => !process.env[name])
    if (missing.length > 0)
      fail('SEAT_CODEX_ROOM_MCP_ENV_MISSING', `seat環境が無い: ${missing.join(',')}`)
    const current = repairSplicedBegin(existsSync(configFile) ? readFileSync(configFile, 'utf8') : '')
    const range = markerRange(current)
    let next
    if (range) {
      next = `${current.slice(0, range.start)}${expectedBlock(range.addedNewline)}${current.slice(range.end)}`
    } else {
      if (roomHeader.test(current))
        fail('SEAT_CODEX_ROOM_MCP_CONFLICT', `${configFile} にproject所有のmcp_servers.roomがある`)
      const addedNewline = current.length > 0 && !current.endsWith('\n')
      next = `${current}${addedNewline ? '\n' : ''}${expectedBlock(addedNewline)}`
    }
    if (next !== current)
      atomicWrite(configFile, next, existsSync(configFile) ? statSync(configFile).mode & 0o777 : 0o644)
    ensureExclude()
    process.stdout.write(`codex room MCP: ${configFile}\n`)
  } else {
    if (existsSync(configFile)) {
      const current = readFileSync(configFile, 'utf8')
      const range = markerRange(current)
      if (range) {
        const start = range.addedNewline && range.start > 0 && current[range.start - 1] === '\n'
          ? range.start - 1 : range.start
        const next = `${current.slice(0, start)}${current.slice(range.end)}`
        if (next.length === 0) {
          unlinkSync(configFile)
          try { rmdirSync(configDir) } catch {}
        } else atomicWrite(configFile, next, statSync(configFile).mode & 0o777)
      }
    }
    removeExclude()
    process.stdout.write('codex room MCP: removed\n')
  }
} catch (error) {
  fail(action === 'ensure' ? 'SEAT_CODEX_ROOM_MCP_UPDATE_FAILED' : 'SEAT_CODEX_ROOM_MCP_REMOVE_FAILED', error.message)
}
