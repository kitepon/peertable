// 明示されたprojectだけに、Peertableの生成物と所有記録を置く。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { packageRoot } from './install-skill.mjs'
import { expectedRoomMcp, isExpectedRoomMcp } from './room-mcp-config.mjs'
import { resolveLatticeInvocation } from './seat-usage.mjs'

export const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), { code }) }
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

export function projectPath(input) {
  if (!input) fail('PEERTABLE_PROJECT_REQUIRED', '対象projectのパスを指定してください')
  const path = realpathSync(input)
  if (!lstatSync(path).isDirectory()) fail('PEERTABLE_PROJECT_INVALID', path)
  return path
}

export function readSetup(project) {
  const file = join(project, '.team', 'setup-state.json')
  if (!existsSync(file)) fail('RESUME_NOT_SET_UP', `${project}は未setupです`)
  const state = readJson(file)
  if (!state || !['standalone', 'lattice'].includes(state.mode) || !state.room || !state.server_url)
    fail('PEERTABLE_SETUP_STATE_INVALID', file)
  return state
}

export function runScript(script, args = [], { root = packageRoot, env = process.env, cwd } = {}) {
  return execFileSync(process.execPath, [join(root, 'skill', 'scripts', script), ...args], {
    encoding: 'utf8', cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function excludePath(project) {
  try {
    return execFileSync('git', ['-C', project, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (error) {
    if (error.code === 'ENOENT') throw error
    return null // git管理外のprojectも単独モードで使える。
  }
}

export function addExclude(project, rule) {
  const path = excludePath(project)
  if (!path) return false
  const body = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (body.split(/\r?\n/u).includes(rule)) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${body}${body && !body.endsWith('\n') ? '\n' : ''}${rule}\n`)
  return true
}

export function removeExclude(project, rule) {
  const path = excludePath(project)
  if (!path || !existsSync(path)) return
  const body = readFileSync(path, 'utf8')
  writeFileSync(path, body.split('\n').filter(line => line.replace(/\r$/u, '') !== rule).join('\n'))
}

export function ensureProjectRoomMcp(project, state, { root = packageRoot } = {}) {
  const file = join(project, '.mcp.json')
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail('PEERTABLE_MCP_CONFLICT', '.mcp.jsonはsymlinkです')
  const mcp = existsSync(file) ? readJson(file) : {}
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)
    || (mcp.mcpServers !== undefined && (!mcp.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers))))
    fail('PEERTABLE_MCP_CONFLICT', '.mcp.jsonの形式が不正です')
  const expected = expectedRoomMcp(root)
  if (mcp.mcpServers?.room !== undefined) {
    if (!isExpectedRoomMcp(mcp.mcpServers.room, expected)) fail('PEERTABLE_MCP_CONFLICT', '既存のroom MCP定義が異なります')
    return
  }
  if (!(state.room_mcp_managed ?? state.added_root_mcp)) fail('PEERTABLE_MCP_CONFLICT', '利用者が管理するroom MCP定義がありません')
  mcp.mcpServers ??= {}
  mcp.mcpServers.room = expected
  // 所有記録の保存後にだけ置換する。書込み失敗で利用者の設定を切り詰めない。
  const temporary = `${file}.peertable-${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(mcp, null, 2)}\n`, { mode: existsSync(file) ? lstatSync(file).mode & 0o777 : 0o600 })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

export function scaffoldProject(options, { root = packageRoot } = {}) {
  const project = projectPath(options.project)
  const team = join(project, '.team')
  try {
    const info = lstatSync(team)
    if (info.isSymbolicLink() || !info.isDirectory()) fail('PEERTABLE_SETUP_TEAM_CONFLICT', '.teamは通常ディレクトリではありません')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existsSync(join(team, 'setup-state.json'))) {
    const state = readSetup(project)
    if ((options.room && options.room !== state.room)
      || (options.url && options.url.replace(/\/+$/u, '') !== state.server_url.replace(/\/+$/u, '')))
      fail('PEERTABLE_SETUP_TARGET_CONFLICT', '既存projectのroomまたはserverと指定が違います')
    ensureProjectRoomMcp(project, state, { root })
    return { project, state, action: 'resume' }
  }
  if (existsSync(team) && (!lstatSync(team).isDirectory() || lstatSync(team).isSymbolicLink() || readdirSync(team).length))
    fail('PEERTABLE_SETUP_TEAM_CONFLICT', '.teamに既存資産があります')
  if (excludePath(project)) {
    const tracked = execFileSync('git', ['-C', project, 'ls-files', '--cached', '--', '.team'], { encoding: 'utf8' })
    if (tracked.trim()) fail('PEERTABLE_SETUP_TEAM_CONFLICT', '.teamにgit追跡済みの資産があります')
  }
  const room = options.room || basename(project)
  if (!/^[A-Za-z0-9._-]+$/u.test(room)) fail('PEERTABLE_ROOM_INVALID', room)
  const url = (options.url || '').replace(/\/+$/u, '')
  let parsedUrl
  try { parsedUrl = new URL(url) } catch { fail('PEERTABLE_SERVER_REQUIRED', '--urlにroom server URLを指定してください') }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password)
    fail('PEERTABLE_SERVER_INVALID', 'HTTP/HTTPSのroom serverを指定してください')
  const mode = options.plan && options.plan !== '-' ? 'lattice' : 'standalone'
  const phases = options.phases ?? []
  if (phases.some(phase => !/^[A-Za-z0-9._-]+$/u.test(phase)) || (mode === 'standalone' && phases.length))
    fail('PEERTABLE_PHASE_INVALID', 'phaseはLatticeモードの有効なIDだけを指定できます')
  let tasks
  if (mode === 'standalone') {
    if (!options.tasks) fail('PEERTABLE_TASKS_REQUIRED', '単独モードには--tasksで議題ファイルを指定してください')
    tasks = readFileSync(resolve(options.tasks), 'utf8')
    if (!tasks.trim()) fail('PEERTABLE_TASKS_REQUIRED', '議題ファイルが空です')
  }
  if (mode === 'lattice') {
    const gitRoot = execFileSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    if (realpathSync(gitRoot) !== project) fail('PEERTABLE_PROJECT_INVALID', 'Latticeモードはgit rootを指定してください')
    const invocation = resolveLatticeInvocation(options.latticeCli || process.env.LATTICE_CLI || 'lattice', ['--version'])
    execFileSync(invocation.command, invocation.argv, { cwd: project, encoding: 'utf8', timeout: 15_000 })
  }
  const mcpPath = join(project, '.mcp.json')
  try { if (lstatSync(mcpPath).isSymbolicLink()) fail('PEERTABLE_MCP_CONFLICT', '.mcp.jsonはsymlinkです') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const preexisting = existsSync(mcpPath)
  if (preexisting && (!lstatSync(mcpPath).isFile() || lstatSync(mcpPath).isSymbolicLink()))
    fail('PEERTABLE_MCP_CONFLICT', '.mcp.jsonは通常ファイルである必要があります')
  const mcp = preexisting ? readJson(mcpPath) : {}
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)
    || (mcp.mcpServers !== undefined && (!mcp.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers))))
    fail('PEERTABLE_MCP_CONFLICT', '.mcp.jsonの形式が不正です')
  const roomPreexisting = mcp.mcpServers?.room !== undefined
  if (roomPreexisting && !isExpectedRoomMcp(mcp.mcpServers.room, expectedRoomMcp(root)))
    fail('PEERTABLE_MCP_CONFLICT', '既存のroom MCP定義が異なります')

  const state = {
    room, server_url: url, public_url: options.publicUrl || url, mode,
    plan_key: mode === 'lattice' ? options.plan : '', phases,
    lattice_cli: options.latticeCli || process.env.LATTICE_CLI || '',
    lattice_preexisting: existsSync(join(project, '.lattice')),
    runtime_preexisting: existsSync(join(project, '.lattice', 'runtime')),
    added_exclude: false, added_mcp_exclude: false, added_runtime_exclude: false,
    added_root_mcp: !preexisting, room_mcp_managed: !roomPreexisting,
    external_pane: false, project_json_preexisting: false,
    work_order_adapter: false, work_order_spool_ref: '',
  }
  try {
    mkdirSync(join(team, 'roles'), { recursive: true })
    mkdirSync(join(team, 'scripts'), { recursive: true })
    if (!roomPreexisting && preexisting) writeFileSync(join(team, 'root-mcp.original.json'), readFileSync(mcpPath))
    if (mode === 'standalone') writeFileSync(join(team, 'tasks.md'), readFileSync(join(root, 'skill', 'templates', 'tasks.md'), 'utf8') + tasks)
    writeJson(join(team, 'setup-state.json'), state)
  } catch (error) {
    // この時点では既存設定へ未着手。今回作った足場だけを戻して再実行可能にする。
    try { rmSync(team, { recursive: true, force: true }) }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'setup記録の保存と足場の撤去が失敗しました') }
    throw error
  }
  ensureProjectRoomMcp(project, state, { root })
  state.added_exclude = addExclude(project, '.team/')
  if (!preexisting) state.added_mcp_exclude = addExclude(project, '/.mcp.json')
  if (mode === 'lattice') state.added_runtime_exclude = addExclude(project, '/.lattice/runtime/')
  writeJson(join(team, 'setup-state.json'), state)
  runScript('upgrade-team-assets.mjs', [project], { root })
  if (mode === 'lattice') {
    state.project_json_preexisting = runScript('external-pane.mjs', [project, room, state.public_url], { root }) === 'true'
    state.external_pane = true
    writeJson(join(team, 'setup-state.json'), state)
  }
  return { project, state, action: 'created' }
}
