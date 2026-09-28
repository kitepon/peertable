// user領域のMCP/hookはPeertableのentryだけを所有する。外部設定を読む前後で照合する。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parentHome, atomicJson, readJson, hookCommand, failure } from './parent-platform.mjs'
import { digest } from './parent-delivery.mjs'
import { codexConnection } from './parent-receivers/codex.mjs'

export const parentServerName = 'peertable_parent'
const hookEntry = fileURLToPath(new URL('./parent-hook.mjs', import.meta.url))
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
export function hookEntries(target) {
  const command = hookCommand(process.execPath, [hookEntry, target])
  const native = target === 'claude' ? { type: 'command', command: process.execPath, args: [hookEntry, target] } : { type: 'command', command }
  if (target === 'cursor') return Object.fromEntries(['preToolUse', 'postToolUse', 'afterMCPExecution', 'sessionEnd'].map(name => [name, [{ command }]]))
  if (target === 'claude') return {
    PreToolUse: [{ matcher: '^mcp__peertable_parent__parent_(join|read|leave)$', hooks: [{ ...native, timeout: 20 }] }],
    PostToolUse: [{ matcher: '^mcp__peertable_parent__parent_join$', hooks: [{ ...native, asyncRewake: true, timeout: 86400 }] }],
    Stop: [{ hooks: [{ ...native, asyncRewake: true, timeout: 86400 }] }], SessionEnd: [{ hooks: [{ ...native, timeout: 20 }] }],
  }
  if (target === 'codex') return { PostToolUse: [{ matcher: '.*', hooks: [{ ...native, timeout: 20, additionalContextLimit: 0 }] }], Stop: [{ hooks: [{ ...native, timeout: 20 }] }] }
  return Object.fromEntries(['PreToolUse', 'PostToolUse', 'SessionEnd'].map(name => [name, [{ hooks: [{ ...native, timeout: 20 }] }]]))
}
const commandIdentity = entry => JSON.stringify([entry.command, entry.args ?? []])
export function ownsParentConnection(target, { home = parentHome() } = {}) {
  const file = join(home, 'connections', `${target}.json`)
  if (!existsSync(file)) return false
  const record = readJson(file)
  const commands = Object.values(hookEntries(target)).flatMap(groups => groups.flatMap(group => group.hooks ?? [group])).map(commandIdentity)
  return record.status === 'registered' && commands.every(command => record.commands.includes(command))
}
export function mergeOwnedHooks(current, additions, ownedCommands, original = { keys: Object.keys(current), event_names: Object.keys(current.hooks ?? {}) }) {
  const next = { ...current, hooks: { ...(current.hooks ?? {}) } }
  for (const name of new Set([...Object.keys(next.hooks), ...Object.keys(additions)])) {
    if (!Array.isArray(next.hooks[name] ?? [])) throw failure('PARENT_HOOK_CONFIG_INVALID')
    let inserted = false, removed = false
    const groups = []
    for (const group of next.hooks[name] ?? []) {
      const hooks = group.hooks ?? [group]
      const owns = hooks.some(hook => ownedCommands.includes(commandIdentity(hook)))
      if (!owns) { groups.push(group); continue }
      removed = true
      const foreign = hooks.filter(hook => !ownedCommands.includes(commandIdentity(hook)))
      if (foreign.length) groups.push({ ...group, hooks: foreign })
      if (!inserted && additions[name]) { groups.push(...additions[name]); inserted = true }
    }
    if (!inserted && additions[name]) groups.push(...additions[name])
    if (removed && !groups.length && !original.event_names.includes(name)) delete next.hooks[name]
    else next.hooks[name] = groups
  }
  if (!original.keys.includes('hooks') && !Object.keys(next.hooks).length) delete next.hooks
  return next
}
const jsonShape = file => {
  const value = existsSync(file) ? readJson(file) : {}
  return { existed: existsSync(file), keys: Object.keys(value), event_names: Object.keys(value.hooks ?? {}) }
}
function writeOwnedJson(file, value, original) {
  if (!original.existed && !Object.keys(value).length) rmSync(file, { force: true })
  else atomicJson(file, value)
  if (existsSync(file) ? digest(readJson(file)) !== digest(value) : Object.keys(value).length !== 0) throw failure('PARENT_CONFIG_READBACK_FAILED')
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

export async function removeCodexConfiguration(client, filePath, trust = []) {
  // 追加したtableの区切りも公式APIが撤去する。手でheaderだけ消すと追加された空行が残る。
  await client.request('config/batchWrite', { filePath, edits: [
    { keyPath: `mcp_servers.${parentServerName}`, value: null, mergeStrategy: 'replace' },
    ...trust.map(hook => ({ keyPath: `hooks.state.${JSON.stringify(hook.key)}`, value: null, mergeStrategy: 'replace' })),
  ] })
}

export async function connectParent(target, { remove = false } = {}) {
  if (!['claude', 'codex', 'grok', 'cursor'].includes(target)) throw failure('PARENT_TARGET_INVALID')
  const paths = pathFor(target), recordPath = join(parentHome(), 'connections', `${target}.json`)
  const previous = existsSync(recordPath) ? readJson(recordPath) : null
  const registration = parentRegistration(), additions = remove ? {} : hookEntries(target)
  const commands = Object.values(hookEntries(target)).flatMap(groups => groups.flatMap(group => group.hooks ?? [group])).map(commandIdentity)
  const ownedCommands = [...new Set([...(previous?.commands ?? []), ...commands])]
  // 初回の形だけを記録する。利用者の現在値をbackup丸ごとで戻さず、自分が追加した空の容器だけを撤去する。
  const currentShape = { hooks: jsonShape(paths.hooks), ...(['claude', 'cursor'].includes(target) ? { mcp: jsonShape(paths.mcp) } : {}) }
  const shape = previous?.status === 'registered' ? previous.json_shape : currentShape
  if (!shape) throw failure('PARENT_CONFIG_BASELINE_MISSING', 'この登録には導入前の設定構造の記録がありません')
  const currentHooks = existsSync(paths.hooks) ? readJson(paths.hooks) : {}
  const currentOwned = Object.fromEntries(Object.entries(currentHooks.hooks ?? {}).map(([key, groups]) => [key, groups.filter(group => (group.hooks ?? [group]).some(hook => ownedCommands.includes(commandIdentity(hook))))]).filter(([, groups]) => groups.length))
  if (previous && digest(currentOwned) !== previous.hooks_digest) throw failure('PARENT_CONFIG_OWNERSHIP_CONFLICT', 'Peertableのhookに未監査の編集があります')
  const nextHooks = mergeOwnedHooks(currentHooks, additions, ownedCommands, shape.hooks)
  if (target === 'cursor' && !remove) nextHooks.version = currentHooks.version ?? 1
  if (target === 'cursor' && remove && !shape.hooks.keys.includes('version') && nextHooks.version === 1) delete nextHooks.version
  const archive = backup([paths.mcp, paths.hooks])
  if (target === 'claude' || target === 'cursor') {
    const current = existsSync(paths.mcp) ? readJson(paths.mcp) : {}, entry = current.mcpServers?.[parentServerName]
    if (entry && digest(entry) !== previous?.mcp_digest && digest(entry) !== digest(registration) && digest(entry) !== digest({ type: 'stdio', ...registration })) throw failure('PARENT_CONFIG_OWNERSHIP_CONFLICT')
    const next = { ...current, mcpServers: { ...(current.mcpServers ?? {}) } }
    if (remove) delete next.mcpServers[parentServerName]
    else next.mcpServers[parentServerName] = target === 'claude' ? { type: 'stdio', ...registration } : registration
    if (remove && !shape.mcp.keys.includes('mcpServers') && !Object.keys(next.mcpServers).length) delete next.mcpServers
    writeOwnedJson(paths.mcp, next, shape.mcp)
  } else if (target === 'grok') {
    const text = existsSync(paths.mcp) ? readFileSync(paths.mcp, 'utf8') : ''
    const block = remove ? '' : grokMcpBlock(registration)
    writeText(paths.mcp, replaceOwnedToml(text, block, previous?.mcp_digest))
  } else {
    mkdirSync(dirname(paths.mcp), { recursive: true })
    const client = await codexConnection(dirname(paths.mcp))
    try {
      const current = await client.request('config/read', { includeLayers: true })
      const entry = current.config?.mcp_servers?.[parentServerName]
      if (entry && previous?.mcp_digest !== digest(entry) && digest(entry) !== digest(registration)) throw failure('PARENT_CONFIG_OWNERSHIP_CONFLICT')
      if (remove) {
        await removeCodexConfiguration(client, paths.mcp, previous?.trust)
      } else await client.request('config/batchWrite', { filePath: paths.mcp, edits: [{ keyPath: `mcp_servers.${parentServerName}`, value: registration, mergeStrategy: 'replace' }] })
    } finally { await client.close() }
  }
  writeOwnedJson(paths.hooks, nextHooks, shape.hooks)
  let trust = null
  if (target === 'codex' && !remove) {
    const client = await codexConnection(dirname(paths.mcp))
    try {
      const list = () => client.request('hooks/list', { cwds: [dirname(paths.mcp)] })
      const own = (await list()).data.flatMap(group => group.hooks ?? []).filter(hook => hook.sourcePath === paths.hooks && ownedCommands.includes(commandIdentity({ command: hook.command })))
      if (own.length !== 2) throw failure('PARENT_CODEX_HOOK_NOT_DISCOVERED')
      await client.request('config/batchWrite', { filePath: paths.mcp, edits: own.flatMap(hook => [
        { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' },
        { keyPath: `hooks.state.${JSON.stringify(hook.key)}.enabled`, value: true, mergeStrategy: 'replace' },
      ]) })
      trust = (await list()).data.flatMap(group => group.hooks ?? []).filter(hook => own.some(entry => entry.key === hook.key))
      if (trust.some(hook => !hook.enabled || hook.trustStatus !== 'trusted')) throw failure('PARENT_CODEX_HOOK_UNTRUSTED')
    } finally { await client.close() }
  }
  const savedOwned = Object.fromEntries(Object.entries(nextHooks.hooks ?? {}).map(([key, groups]) => [key, groups.filter(group => (group.hooks ?? [group]).some(hook => ownedCommands.includes(commandIdentity(hook))))]).filter(([, groups]) => groups.length))
  let mcpDigest = target === 'grok' ? digest(ownedTomlBlock(readFileSync(paths.mcp, 'utf8')).block) : target === 'claude' ? digest({ type: 'stdio', ...registration }) : digest(registration)
  if (target === 'codex' && !remove) {
    const client = await codexConnection(dirname(paths.mcp))
    try {
      const entry = (await client.request('config/read', { includeLayers: true })).config?.mcp_servers?.[parentServerName]
      if (entry?.command !== registration.command || digest(entry.args) !== digest(registration.args)) throw failure('PARENT_CONFIG_READBACK_FAILED')
      mcpDigest = digest(entry)
    } finally { await client.close() }
  }
  const result = { schema: 'peertable.parent-connect.v1', target, status: remove ? 'removed' : 'registered', runtime_status: remove ? 'stopped' : 'PARENT_RESTART_REQUIRED', paths, commands: ownedCommands, hooks_digest: digest(savedOwned), mcp_digest: mcpDigest, json_shape: shape, backup: archive, trust, updated_at: new Date().toISOString() }
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
