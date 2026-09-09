#!/usr/bin/env node
// skill配置だけを所有する。project、room、AIの設定ファイルは変更しない。
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const clients = Object.freeze(['claude', 'codex', 'grok', 'cursor'])
export const packageRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })
const stat = path => {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function ownedLink(target, source) {
  if (resolve(target) === source) return true
  // 旧手動配置はPeertable packageのskillへのリンクだけを移行する。
  if (target.split(/[\\/]/u).at(-1) !== 'skill') return false
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(target), 'package.json'), 'utf8'))
    return pkg.name === 'peertable' && existsSync(join(target, 'SKILL.md'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
    throw error
  }
}

export function inspectSkill({ root = packageRoot, home = homedir(), targets } = {}) {
  const source = realpathSync(join(root, 'skill'))
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const selected = targets?.length ? targets : clients.filter(client => existsSync(join(home, `.${client}`)))
  for (const client of selected) {
    if (!clients.includes(client)) throw fail('PEERTABLE_SKILL_TARGET_UNKNOWN', client)
  }
  const entries = [...new Set(selected)].map(client => {
    const path = join(home, `.${client}`, 'skills', 'peertable')
    const info = stat(path)
    if (!info) return { client, path, status: 'missing' }
    if (!info.isSymbolicLink()) return { client, path, status: 'conflict' }
    const target = resolve(dirname(path), readlinkSync(path))
    if (target === source) return { client, path, status: 'current' }
    return { client, path, status: ownedLink(target, source) ? 'outdated' : 'conflict' }
  })
  return { schema: 'peertable.skill-install.v1', version, source, targets: entries,
    status: !entries.length ? 'not_detected' : entries.every(entry => entry.status === 'current') ? 'ready' : 'required' }
}

export function installSkill(options = {}) {
  const result = inspectSkill(options)
  // 外部の既存資産との衝突は、どの導入先へも書き込む前に知らせる。
  const conflicts = result.targets.filter(entry => entry.status === 'conflict')
  if (conflicts.length) throw fail('PEERTABLE_SKILL_CONFLICT', conflicts.map(entry => entry.path).join(', '))
  for (const entry of result.targets) {
    if (entry.status === 'current') continue
    mkdirSync(dirname(entry.path), { recursive: true })
    // symlinkだけを取り替え、旧リンク先のsourceは一切変更しない。
    if (entry.status === 'outdated') unlinkSync(entry.path)
    symlinkSync(result.source, entry.path, process.platform === 'win32' ? 'junction' : 'dir')
    entry.status = entry.status === 'missing' ? 'installed' : 'updated'
    if (realpathSync(entry.path) !== result.source) throw fail('PEERTABLE_SKILL_VERIFY_FAILED', entry.path)
  }
  result.status = result.targets.length ? 'ready' : 'not_detected'
  return result
}

export function skillCommand(args) {
  const targets = []
  let check = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') continue
    if (arg === '--check') { check = true; continue }
    if (arg === '--target' && args[index + 1]) { targets.push(args[++index]); continue }
    throw fail('PEERTABLE_SKILL_ARGUMENT_INVALID', arg)
  }
  return check ? inspectSkill({ targets }) : installSkill({ targets })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--postinstall') && process.env.npm_config_global !== 'true') process.exit(0)
    const result = skillCommand(process.argv.slice(2).filter(arg => arg !== '--postinstall'))
    console.log(JSON.stringify(result))
    if (process.argv.includes('--check') && result.status !== 'ready') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ schema: 'peertable.error.v1', code: error.code ?? 'PEERTABLE_SKILL_INSTALL_FAILED', message: error.message }))
    process.exitCode = 1
  }
}
