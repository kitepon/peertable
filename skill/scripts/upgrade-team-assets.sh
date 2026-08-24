#!/bin/bash
# 既存卓へ、Peertable が所有する generated assetとroot room MCPだけを現行treeへ同期する。
# usage: upgrade-team-assets.sh <project_dir>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo 'PEERTABLE_UPGRADE_USAGE: upgrade-team-assets.sh <project_dir>' >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)

node --input-type=module - "$1" "$repo_dir" <<'NODE'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectArg = process.argv[2]
const repoDir = process.argv[3]
const { expectedRoomMcp, isExpectedRoomMcp } = await import(pathToFileURL(
  join(repoDir, 'skill', 'scripts', 'room-mcp-config.mjs')))

function fail(code, detail) {
  console.error(JSON.stringify({
    schema: 'peertable.generated_assets_upgrade_result.v2',
    result: 'rejected',
    code,
    detail,
  }))
  process.exit(1)
}

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    fail('PEERTABLE_UPGRADE_PATH_UNREADABLE', `${path}: ${error.message}`)
  }
}

function requireRegularFile(path, code, label) {
  const stat = lstatOrNull(path)
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    fail(code, `${label}: ${path}`)
  }
  return stat
}

function validateDirectory(path, required, label) {
  const stat = lstatOrNull(path)
  if (!stat) {
    if (required) fail('PEERTABLE_GENERATED_ASSET_UNSAFE_PATH', `${label} が無い: ${path}`)
    return false
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('PEERTABLE_GENERATED_ASSET_UNSAFE_PATH', `${label} がsymlinkまたはdirectoryでない: ${path}`)
  }
  return true
}

function validateTargetPath(project, relativePath) {
  const parts = relativePath.split('/')
  let current = project
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    validateDirectory(current, part === '.team', `管理asset親 ${part}`)
  }
  const target = join(project, relativePath)
  const stat = lstatOrNull(target)
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    fail('PEERTABLE_GENERATED_ASSET_UNSAFE_PATH', `管理assetがsymlinkまたはregular fileでない: ${target}`)
  }
  return { target, stat }
}

function templateText(repo, relativePath) {
  const path = join(repo, relativePath)
  requireRegularFile(path, 'PEERTABLE_GENERATED_ASSET_TEMPLATE_INVALID', 'template')
  try {
    return readFileSync(path)
  } catch (error) {
    fail('PEERTABLE_GENERATED_ASSET_TEMPLATE_INVALID', `${path}: ${error.message}`)
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function renderMember(template, state) {
  if (state.mode === 'standalone') return template
  const phases = state.phases
  const scope = phases.length === 0
    ? 'この卓の claim 範囲は plan 全体（phase 指定なしで立っている）。'
    : `**この卓の claim 範囲は phase ${phases.join(' ')} の task だけ**。範囲外の phase の task は、ready に見えていても取らない——同じ plan へ別 campaign が相乗りしている時、範囲外を取ると他卓の工程を横取りする（越境が2回実測されたことへの対処）。範囲外に手を入れる必要が出たら room へ出して裁定を仰ぐ。`
  return template
    .toString('utf8')
    .replaceAll('{{PLAN_KEY}}', state.plan_key)
    .replaceAll('{{CLAIM_SCOPE}}', scope)
}

function loadState(project) {
  const path = join(project, '.team', 'setup-state.json')
  requireRegularFile(path, 'PEERTABLE_SETUP_STATE_INVALID', 'setup-state.json')
  let state
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('PEERTABLE_SETUP_STATE_INVALID', `${path}: JSONを読めない: ${error.message}`)
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    fail('PEERTABLE_SETUP_STATE_INVALID', 'setup-state.json はobjectでなければならない')
  }
  if (!['lattice', 'standalone'].includes(state.mode)) {
    fail('PEERTABLE_SETUP_STATE_INVALID', `modeが不正: ${String(state.mode)}`)
  }
  if (typeof state.room !== 'string' || !state.room || typeof state.server_url !== 'string' || !state.server_url) {
    fail('PEERTABLE_SETUP_STATE_INVALID', 'room/server_url が不正')
  }
  if (typeof state.plan_key !== 'string') {
    fail('PEERTABLE_SETUP_STATE_INVALID', 'plan_key がstringでない')
  }
  if (state.mode === 'lattice' && !state.plan_key) {
    fail('PEERTABLE_SETUP_STATE_INVALID', 'lattice mode の plan_key が空')
  }
  if (state.phases !== undefined && (!Array.isArray(state.phases) || state.phases.some(phase => typeof phase !== 'string' || !phase))) {
    fail('PEERTABLE_SETUP_STATE_INVALID', 'phases がstring配列でない')
  }
  for (const key of ['added_root_mcp', 'root_mcp_json_fallback']) {
    if (state[key] !== undefined && typeof state[key] !== 'boolean') {
      fail('PEERTABLE_SETUP_STATE_INVALID', `${key} がbooleanでない`)
    }
  }
  return { ...state, phases: state.phases ?? [],
    root_mcp_managed: state.added_root_mcp ?? state.root_mcp_json_fallback ?? false }
}

function prepareRoomMcp(project, repo, state) {
  const relativePath = '.mcp.json'
  const { target, stat } = validateTargetPath(project, relativePath)
  if (!state.root_mcp_managed && !stat) {
    fail('PEERTABLE_PREEXISTING_MCP_STALE', `${target}: 既存room MCPが無い。手動mergeが必要`)
  }
  let config = { mcpServers: {} }
  if (stat) {
    try {
      config = JSON.parse(readFileSync(target, 'utf8'))
    } catch (error) {
      fail(state.root_mcp_managed ? 'PEERTABLE_MANAGED_MCP_INVALID' : 'PEERTABLE_PREEXISTING_MCP_STALE',
        `${target}: JSONを読めない: ${error.message}`)
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.mcpServers !== undefined
      && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    fail(state.root_mcp_managed ? 'PEERTABLE_MANAGED_MCP_INVALID' : 'PEERTABLE_PREEXISTING_MCP_STALE',
      `${target}: root/mcpServersがobjectでない`)
  }
  const expected = expectedRoomMcp(repo)
  if (!state.root_mcp_managed) {
    if (!isExpectedRoomMcp(config.mcpServers?.room, expected)) {
      fail('PEERTABLE_PREEXISTING_MCP_STALE', `${target}: room blockを現行treeへ手動mergeする必要がある`)
    }
    return { item: null,
      report: { path: relativePath, ownership: 'preexisting', action: 'unchanged-preexisting' } }
  }
  config.mcpServers ??= {}
  config.mcpServers.room = expected
  const item = { relativePath, sourcePath: 'room/client.mjs', target, stat,
    content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'), mode: stat ? stat.mode & 0o777 : 0o644 }
  return { item, report: { path: relativePath, ownership: 'managed', action: null } }
}

function writeAtomically(target, content, mode) {
  const temporary = join(dirname(target), `.${basename(target)}.upgrade-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, content, { mode })
    chmodSync(temporary, mode)
    renameSync(temporary, target)
  } catch (error) {
    try { lstatSync(temporary); unlinkSync(temporary) } catch {}
    fail('PEERTABLE_GENERATED_ASSET_WRITE_FAILED', `${target}: ${error.message}`)
  }
}

function main() {
  if (!projectArg || !repoDir) fail('PEERTABLE_UPGRADE_USAGE', 'project_dir が無い')
  const projectStat = lstatOrNull(projectArg)
  if (!projectStat || projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    fail('PEERTABLE_UPGRADE_PROJECT_INVALID', `project directoryが不正: ${projectArg}`)
  }
  const project = resolve(projectArg)
  const repo = resolve(repoDir)
  validateDirectory(join(project, '.team'), true, '.team')
  validateDirectory(join(repo, 'skill'), true, 'Peertable repo')
  const state = loadState(project)

  const common = [
    ['.team/CLAUDE.md', 'skill/templates/charter.md', 0o644],
    ['.team/roles/parent.md', 'skill/templates/parent.md', 0o644],
  ]
  const modeSpecific = state.mode === 'lattice'
    ? [
        ['.team/roles/member.md', 'skill/templates/member.md', 0o644],
        ['.team/scripts/done.sh', 'skill/templates/done.sh', 0o755],
        ['.team/scripts/independence-refresh.sh', 'skill/templates/independence-refresh.sh', 0o755],
      ]
    : [['.team/roles/member.md', 'skill/templates/member-standalone.md', 0o644]]
  const definitions = [...common, ...modeSpecific]

  const prepared = definitions.map(([relativePath, sourcePath, mode]) => {
    const { target, stat } = validateTargetPath(project, relativePath)
    const source = templateText(repo, sourcePath)
    const content = relativePath === '.team/roles/member.md' && state.mode === 'lattice'
      ? Buffer.from(renderMember(source, state), 'utf8')
      : source
    return { relativePath, sourcePath, target, stat, content, mode }
  })
  const roomMcp = prepareRoomMcp(project, repo, state)
  if (roomMcp.item) prepared.push(roomMcp.item)

  const changes = prepared.map(item => {
    if (!item.stat) return { path: item.relativePath, action: 'created', sha256: sha256(item.content) }
    const current = readFileSync(item.target)
    const mode = item.stat.mode & 0o777
    const modeMatches = process.platform === 'win32' || mode === item.mode
    if (current.equals(item.content) && modeMatches) {
      return { path: item.relativePath, action: 'unchanged', sha256: sha256(item.content) }
    }
    return { path: item.relativePath, action: current.equals(item.content) ? 'mode-updated' : 'updated', sha256: sha256(item.content) }
  })
  const obsolete = ['.team/scripts/start.sh', '.team/scripts/start-event.mjs']
    .map(relativePath => ({ relativePath, ...validateTargetPath(project, relativePath) }))

  // 全対象の安全性・template・差分を先に確定してから、管理allowlistだけへ書く。
  for (const [index, item] of prepared.entries()) {
    const change = changes[index]
    if (change.action === 'unchanged') continue
    const parent = dirname(item.target)
    mkdirSync(parent, { recursive: true, mode: 0o755 })
    if (change.action === 'mode-updated') chmodSync(item.target, item.mode)
    else writeAtomically(item.target, item.content, item.mode)
  }

  const removed = []
  for (const { relativePath, target, stat } of obsolete) {
    if (!stat) continue
    unlinkSync(target)
    removed.push(relativePath)
  }

  console.log(JSON.stringify({
    schema: 'peertable.generated_assets_upgrade_result.v2',
    result: 'ok',
    project,
    mode: state.mode,
    managed: prepared.map(item => ({ path: item.relativePath, source: item.sourcePath, sha256: sha256(item.content) })),
    changes,
    room_mcp: roomMcp.item
      ? { ...roomMcp.report,
          action: changes.find(change => change.path === roomMcp.item.relativePath).action }
      : roomMcp.report,
    removed,
    changed_count: changes.filter(change => change.action !== 'unchanged').length + removed.length,
  }))
}

try {
  main()
} catch (error) {
  if (error?.code && typeof error.message === 'string') fail('PEERTABLE_GENERATED_ASSET_UPGRADE_FAILED', error.message)
  fail('PEERTABLE_GENERATED_ASSET_UPGRADE_FAILED', String(error))
}
NODE
