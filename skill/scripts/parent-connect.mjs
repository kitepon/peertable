// user領域のMCP/hookはPeertableのentryだけを所有する。hookの中身と登録はAitermと同じ（aiterm-steer-delivery）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parentHome, atomicJson, readJson, failure } from './parent-platform.mjs'
import { digest } from './parent-delivery.mjs'
import { PEERTABLE_PROFILE, entries, parentServerName, steer } from './parent-steer.mjs'

export { parentServerName }
const clientEntry = fileURLToPath(new URL('../../room/client.mjs', import.meta.url))
export const parentRegistration = () => ({ command: process.execPath, args: [clientEntry, 'parent'] })
export const grokMcpBlock = registration => `[mcp_servers.${parentServerName}]\ncommand = ${JSON.stringify(registration.command)}\nargs = ${JSON.stringify(registration.args)}\n`
const pathFor = target => {
  const home = homedir()
  if (target === 'claude') return { mcp: join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json'), hooks: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json') }
  if (target === 'cursor') return { mcp: join(process.env.CURSOR_HOME ?? join(home, '.cursor'), 'mcp.json'), hooks: join(process.env.CURSOR_HOME ?? join(home, '.cursor'), 'hooks.json') }
  if (target === 'codex') return { mcp: join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'), hooks: join(process.env.CODEX_HOME ?? join(home, '.codex'), 'hooks.json') }
  return { mcp: join(home, '.grok', 'config.toml'), hooks: join(home, '.grok', 'hooks', 'peertable-parent.json') }
}
const hookRuntime = target => ({ command: process.execPath, script: entries[target] })
export function ownsParentConnection(target, { home = parentHome() } = {}) {
  const file = join(home, 'connections', `${target}.json`)
  if (!existsSync(file)) return false
  const record = readJson(file)
  return record.status === 'registered' && record.schema === 'peertable.parent-connect.v2'
}
// 旧方式（parent-hook.mjs）の登録を、利用者や他製品のhookを残したまま取り除く。
const legacyHook = hook => [hook?.command, ...(Array.isArray(hook?.args) ? hook.args : [])].some(value => typeof value === 'string' && /[/\\]parent-hook\.mjs\b/u.test(value))
export function removeLegacyHooks(file) {
  if (!existsSync(file)) return false
  const current = readJson(file)
  if (!current || typeof current !== 'object' || !current.hooks || typeof current.hooks !== 'object') return false
  const hooks = {}
  let changed = false
  for (const [event, groups] of Object.entries(current.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue }
    const kept = groups.flatMap(group => {
      if (Array.isArray(group?.hooks)) {
        const rest = group.hooks.filter(hook => !legacyHook(hook))
        if (rest.length !== group.hooks.length) changed = true
        return rest.length ? [{ ...group, hooks: rest }] : []
      }
      if (legacyHook(group)) { changed = true; return [] }
      return [group]
    })
    if (kept.length) hooks[event] = kept
  }
  if (!changed) return false
  atomicJson(file, { ...current, hooks })
  return true
}
// TOMLのliteral/basic quoted keyを解析して自分のtableだけを置換する。
// 他のtableの本文・順序・コメントはbyte単位で残す。
export function tomlHeaderKeys(line) {
  const match = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/u.exec(line)
  if (!match) return null
  const raw = match[1], keys = []
  let index = 0
  while (index < raw.length) {
    while (/\s/u.test(raw[index] ?? '') && index < raw.length) index++
    const quote = raw[index]
    if (quote === '"' || quote === "'") {
      const start = index++
      while (index < raw.length && (raw[index] !== quote || (quote === '"' && raw[index - 1] === '\\'))) index++
      if (index >= raw.length) throw failure('PARENT_TOML_HEADER_INVALID')
      const token = raw.slice(start, ++index)
      keys.push(quote === '"' ? JSON.parse(token) : token.slice(1, -1))
    } else {
      const token = /^[A-Za-z0-9_-]+/u.exec(raw.slice(index))?.[0]
      if (!token) throw failure('PARENT_TOML_HEADER_INVALID')
      keys.push(token); index += token.length
    }
    while (/\s/u.test(raw[index] ?? '') && index < raw.length) index++
    if (index < raw.length && raw[index++] !== '.') throw failure('PARENT_TOML_HEADER_INVALID')
  }
  return keys
}
export function ownedTomlBlock(text, rootKeys = ['mcp_servers', parentServerName]) {
  const lines = text.split(/(?<=\n)/u), indexes = []
  for (let index = 0; index < lines.length; index++) {
    const keys = tomlHeaderKeys(lines[index].trimEnd())
    if (keys && rootKeys.every((key, part) => keys[part] === key)) {
      let end = index + 1
      while (end < lines.length && !/^\s*\[/u.test(lines[end])) end++
      indexes.push({ start: index, end })
    }
  }
  return { lines, indexes, block: indexes.map(({ start, end }) => lines.slice(start, end).join('')).join('') }
}
// 自分のtableの値（commandとargsだけ）を読む。Grokは設定を書き直す時に引用符や配列の改行を変えるので、
// 字面ではなく値で所有を照合する。他のキー・行内コメント・読めない書式はnull（照合に使わず、衝突として止まる）。
export function ownedTomlValues(block) {
  const body = block.split(/\r?\n/u).slice(1).map(line => line.trim()).filter(line => line && !line.startsWith('#')).join(' ')
  let index = 0
  const space = () => { while (/\s/u.test(body[index] ?? '')) index++ }
  const string = () => {
    const quote = body[index]
    if (quote === "'") {
      const end = body.indexOf("'", index + 1)
      if (end < 0) return undefined
      const value = body.slice(index + 1, end); index = end + 1; return value
    }
    if (quote !== '"') return undefined
    let end = index + 1
    while (end < body.length && body[end] !== '"') end += body[end] === '\\' ? 2 : 1
    if (end >= body.length) return undefined
    try { const value = JSON.parse(body.slice(index, end + 1)); index = end + 1; return value } catch { return undefined }
  }
  const values = {}
  while (space(), index < body.length) {
    const key = /^[A-Za-z0-9_-]+/u.exec(body.slice(index))?.[0]
    if (!['command', 'args'].includes(key) || Object.hasOwn(values, key)) return null
    index += key.length; space()
    if (body[index++] !== '=') return null
    space()
    if (key === 'command') { values.command = string(); if (values.command === undefined) return null; continue }
    if (body[index++] !== '[') return null
    values.args = []
    while (space(), body[index] !== ']') {
      const item = string()
      if (item === undefined) return null
      values.args.push(item); space()
      if (body[index] === ',') index++
      else if (body[index] !== ']') return null
    }
    index++
  }
  return typeof values.command === 'string' && Array.isArray(values.args) ? values : null
}
export function replaceOwnedToml(text, replacement, expected, rootKeys) {
  const found = ownedTomlBlock(text, rootKeys)
  if (found.block && (expected === undefined || digest(found.block) !== expected)) throw failure('PARENT_CONFIG_OWNERSHIP_CONFLICT')
  const starts = new Map(found.indexes.map(range => [range.start, range]))
  let out = '', inserted = false
  for (let index = 0; index < found.lines.length;) {
    const range = starts.get(index)
    if (range) { if (!inserted) { out += replacement; inserted = true }; index = range.end }
    else out += found.lines[index++]
  }
  return inserted ? out : `${out}${out && !out.endsWith('\n') ? '\n' : ''}${replacement}`
}
function backup(files) {
  const present = files.filter(existsSync)
  if (!present.length) return null
  const dir = join(parentHome(), 'backups'); mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${Date.now()}-${process.pid}.tar`)
  // tarは設定fileだけを控える。認証や会話のHOME全体はコピーしない。
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-cf', file, ...present], { stdio: ['ignore', 'pipe', 'pipe'] })
  return file
}
function writeText(file, text) { mkdirSync(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, file); if (readFileSync(file, 'utf8') !== text) throw failure('PARENT_CONFIG_READBACK_FAILED') }

async function withCodexConfig(codexHome, fn) {
  return steer.withCodexReceiver(PEERTABLE_PROFILE, { thread_id: '00000000-0000-4000-8000-000000000000', codex_home: codexHome }, fn)
}
// Codexのconfig/readは書いていない既定値（enabled=true・environment_id="local"・値の無い項目）を足して返す。
// それを除いた形で所有を照合する。利用者が変えた値（無効化・envの追加など）は残るので衝突として止まる。
export const codexOwnedEntry = entry => Object.fromEntries(Object.entries(entry).filter(([key, value]) =>
  value !== null && !(key === 'enabled' && value === true) && !(key === 'environment_id' && value === 'local')))
export async function removeCodexConfiguration(request, filePath, trust = []) {
  // 追加したtableの区切りも公式APIが撤去する。手でheaderだけ消すと追加された空行が残る。
  await request('config/batchWrite', { filePath, edits: [
    { keyPath: `mcp_servers.${parentServerName}`, value: null, mergeStrategy: 'replace' },
    ...trust.map(hook => ({ keyPath: `hooks.state.${JSON.stringify(hook.key)}`, value: null, mergeStrategy: 'replace' })),
  ] })
}

export async function connectParent(target, { remove = false } = {}) {
  if (!['claude', 'codex', 'grok', 'cursor'].includes(target)) throw failure('PARENT_TARGET_INVALID')
  const paths = pathFor(target), recordPath = join(parentHome(), 'connections', `${target}.json`)
  const previous = existsSync(recordPath) ? readJson(recordPath) : null
  const registration = parentRegistration()
  const archive = backup([paths.mcp, paths.hooks])
  const legacyRemoved = removeLegacyHooks(paths.hooks)
  let delivery = null
  if (target === 'claude' || target === 'cursor') {
    const current = existsSync(paths.mcp) ? readJson(paths.mcp) : {}, entry = current.mcpServers?.[parentServerName]
    if (entry && digest(entry) !== previous?.mcp_digest && digest(entry) !== digest(registration) && digest(entry) !== digest({ type: 'stdio', ...registration })) throw failure('PARENT_CONFIG_OWNERSHIP_CONFLICT')
    const next = { ...current, mcpServers: { ...(current.mcpServers ?? {}) } }
    if (remove) delete next.mcpServers[parentServerName]
    else next.mcpServers[parentServerName] = target === 'claude' ? { type: 'stdio', ...registration } : registration
    if (remove && !Object.keys(next.mcpServers).length) delete next.mcpServers
    mkdirSync(dirname(paths.mcp), { recursive: true })
    atomicJson(paths.mcp, next)
    if (target === 'claude') delivery = remove ? steer.removeClaudeParentHooks(PEERTABLE_PROFILE, paths.hooks) : steer.mergeClaudeParentHooks(PEERTABLE_PROFILE, paths.hooks, hookRuntime('claude'))
    else delivery = remove ? steer.removeCursorParentHooks(PEERTABLE_PROFILE, paths.hooks) : steer.mergeCursorParentHooks(PEERTABLE_PROFILE, paths.hooks, hookRuntime('cursor'))
  } else if (target === 'grok') {
    // Grokは背景の受信processで受け取る（Aitermのwait_processと同じ）。hookは使わない。
    const text = existsSync(paths.mcp) ? readFileSync(paths.mcp, 'utf8') : ''
    const owned = ownedTomlBlock(text).block, values = owned && ownedTomlValues(owned)
    // 値が前回の登録か今回の登録と同じなら、Grokが書き直しただけとみて自分のtableとして扱う。
    const same = values && [previous?.mcp_value_digest, digest(registration)].includes(digest(values))
    writeText(paths.mcp, replaceOwnedToml(text, remove ? '' : grokMcpBlock(registration), same ? digest(owned) : previous?.mcp_digest))
    if (existsSync(paths.hooks) && legacyRemoved && !Object.keys(readJson(paths.hooks).hooks ?? {}).length) rmSync(paths.hooks)
  } else {
    mkdirSync(dirname(paths.mcp), { recursive: true })
    const codexHome = dirname(paths.mcp)
    await withCodexConfig(codexHome, async request => {
      const current = await request('config/read', { includeLayers: true })
      const entry = current.config?.mcp_servers?.[parentServerName], owned = entry && digest(codexOwnedEntry(entry))
      if (entry && previous?.mcp_digest !== owned && owned !== digest(registration)) throw failure('PARENT_CONFIG_OWNERSHIP_CONFLICT')
      if (remove) await removeCodexConfiguration(request, paths.mcp, previous?.trust ?? [])
      else {
        await request('config/batchWrite', { filePath: paths.mcp, edits: [{ keyPath: `mcp_servers.${parentServerName}`, value: registration, mergeStrategy: 'replace' },
          // 旧方式のhookの承認記録も取り除く。
          ...(previous?.trust ?? []).map(hook => ({ keyPath: `hooks.state.${JSON.stringify(hook.key)}`, value: null, mergeStrategy: 'replace' }))] })
        const saved = (await request('config/read', { includeLayers: true })).config?.mcp_servers?.[parentServerName]
        if (saved?.command !== registration.command || digest(saved.args) !== digest(registration.args)) throw failure('PARENT_CONFIG_READBACK_FAILED')
      }
    })
    // 作業中のturnへの差し込み（Steer）はAitermと同じ公式hook。全OSで、Desktop同梱のCodex CLIを先に、無ければ通常のCodex CLIを使う。
    // CLIが古い等で有効にできなくても、公式キューの配送はそのまま使える（Aitermと同じ）。
    try { delivery = await steer.configureCodexSteer(PEERTABLE_PROFILE, remove ? 'disable' : 'enable', { hook: entries.codex, codex_home: codexHome }) }
    catch (error) { delivery = { status: 'failed', reason_code: error.code ?? error.delivery_code ?? 'codex_steer_setup_failed', detail: error.message } }
  }
  const mcpDigest = target === 'grok' ? digest(ownedTomlBlock(readFileSync(paths.mcp, 'utf8')).block) : target === 'claude' ? digest({ type: 'stdio', ...registration }) : digest(registration)
  const result = { schema: 'peertable.parent-connect.v2', target, status: remove ? 'removed' : 'registered', runtime_status: remove ? 'stopped' : 'PARENT_RESTART_REQUIRED', paths,
    delivery, legacy_hooks_removed: legacyRemoved, mcp_digest: mcpDigest, ...(target === 'grok' ? { mcp_value_digest: digest(registration) } : {}),
    backup: archive, updated_at: new Date().toISOString() }
  atomicJson(recordPath, result)
  return result
}
export async function connectCommand(args) {
  const index = args.indexOf('--target'), target = index >= 0 ? args[index + 1] : null
  if (index >= 0 && !target) throw failure('PARENT_TARGET_INVALID')
  const targets = target ? [target] : ['claude', 'codex', 'grok', 'cursor'].filter(name => existsSync(dirname(pathFor(name).hooks)))
  const results = []
  for (const name of targets) {
    try { results.push(await connectParent(name, { remove: args.includes('--remove') })) }
    catch (error) { results.push({ target: name, status: 'failed', error_code: error.code ?? 'PARENT_CONNECT_FAILED', detail: error.message }) }
  }
  return { schema: 'peertable.parent-connections.v1', status: results.length && results.every(result => result.status !== 'failed') ? 'registered' : 'failed', results }
}
