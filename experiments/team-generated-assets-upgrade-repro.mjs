#!/usr/bin/env node
// 既存卓のPeertable管理generated asset同期を、a2欠落・a3 stale・mode境界で再現する。
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upgrade = join(repo, 'skill/scripts/upgrade-team-assets.sh')
const removeManagedMcp = join(repo, 'skill/scripts/remove-managed-room-mcp.mjs')
const ensureRoomMcp = join(repo, 'skill/scripts/ensure-room-mcp.mjs')
const template = relative => readFile(join(repo, 'skill/templates', relative), 'utf8')

async function makeProject(prefix, state) {
  const project = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(project, '.team', 'roles'), { recursive: true })
  await mkdir(join(project, '.team', 'scripts'), { recursive: true })
  await writeFile(join(project, '.team', 'setup-state.json'), `${JSON.stringify(state)}\n`)
  return project
}

function report(result) {
  const line = result.stdout.trim().split(/\r?\n/).at(-1)
  assert.ok(line, `upgrade output is empty: ${result.stderr}`)
  return JSON.parse(line)
}

function run(project) {
  const bash = process.platform === 'win32'
    ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : '/bin/bash'
  const shellPath = path => process.platform === 'win32' ? path.replaceAll('\\', '/') : path
  return spawnSync(bash, [shellPath(upgrade), shellPath(project)], { cwd: repo, encoding: 'utf8' })
}

async function assertLatticePositive() {
  const project = await makeProject('peertable-assets-positive-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'lattice',
    plan_key: 'fixture-plan',
    phases: [],
    added_root_mcp: true,
  })
  try {
    const team = join(project, '.team')
    const sentinel = 'user-owned\n'
    await writeFile(join(team, 'user-notes.txt'), sentinel)
    await mkdir(join(team, 'credentials'))
    await writeFile(join(team, 'credentials', 'api.token'), 'secret-fixture-token\n')
    await writeFile(join(team, 'scripts', 'custom.sh'), '# user script\n')
    await writeFile(join(team, 'scripts', 'done.sh'), '#!/bin/sh\n# a3 stale generated asset\n')
    await writeFile(join(team, 'scripts', 'start.sh'), '# obsolete start notifier\n')
    await writeFile(join(team, 'scripts', 'start-event.mjs'), '// obsolete typed event helper\n')
    await writeFile(join(project, '.mcp.json'), `${JSON.stringify({
      mcpServers: {
        room: { command: 'node', args: ['C:\\old-peertable\\room\\client.mjs'] },
        other: { command: 'other-mcp', args: ['--keep'] },
      },
    }, null, 2)}\n`)

    assert.notEqual(await readFile(join(team, 'scripts', 'done.sh'), 'utf8'), await template('done.sh'))

    const first = run(project)
    assert.equal(first.status, 0, first.stderr)
    const firstReport = report(first)
    assert.equal(firstReport.result, 'ok')
    assert.equal(firstReport.schema, 'peertable.generated_assets_upgrade_result.v2')
    assert.deepEqual(firstReport.removed.sort(), ['.team/scripts/start-event.mjs', '.team/scripts/start.sh'])
    assert.ok(firstReport.changes.some(change => change.path === '.team/scripts/done.sh' && change.action === 'updated'))
    assert.equal(existsSync(join(team, 'scripts', 'start.sh')), false)
    assert.equal(existsSync(join(team, 'scripts', 'start-event.mjs')), false)
    assert.equal(await readFile(join(team, 'scripts', 'done.sh'), 'utf8'), await template('done.sh'))
    assert.match(await readFile(join(team, 'roles', 'member.md'), 'utf8'), /fixture-plan/)
    const mcp = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'))
    assert.deepEqual(mcp.mcpServers.room, { command: 'node', args: [join(repo, 'room', 'client.mjs')] })
    assert.deepEqual(mcp.mcpServers.other, { command: 'other-mcp', args: ['--keep'] })
    assert.ok(firstReport.changes.some(change => change.path === '.mcp.json' && change.action === 'updated'))
    assert.equal(await readFile(join(team, 'user-notes.txt'), 'utf8'), sentinel)
    assert.equal(await readFile(join(team, 'credentials', 'api.token'), 'utf8'), 'secret-fixture-token\n')
    assert.equal(await readFile(join(team, 'scripts', 'custom.sh'), 'utf8'), '# user script\n')

    const second = run(project)
    assert.equal(second.status, 0, second.stderr)
    const secondReport = report(second)
    assert.equal(secondReport.changed_count, 0)
    assert.ok(secondReport.changes.every(change => change.action === 'unchanged'), JSON.stringify(secondReport))

    const removed = spawnSync(process.execPath, [removeManagedMcp, project], { encoding: 'utf8' })
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal(JSON.parse(removed.stdout).action, 'room-removed-file-preserved')
    const afterRemove = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'))
    assert.equal(afterRemove.mcpServers.room, undefined)
    assert.deepEqual(afterRemove.mcpServers.other, { command: 'other-mcp', args: ['--keep'] })
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertStandaloneBoundary() {
  const project = await makeProject('peertable-assets-standalone-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'standalone',
    plan_key: '',
    phases: [],
    added_root_mcp: false,
  })
  try {
    const tasks = '- user-task: user task\n'
    const staleDone = '#!/bin/sh\n# user-owned standalone file\n'
    const preexistingMcp = `${JSON.stringify({
      mcpServers: {
        room: { command: 'node', args: [join(repo, 'room', 'client.mjs')] },
        user: { command: 'user-owned', args: ['--do-not-touch'] },
      },
    }, null, 2)}\n`
    await writeFile(join(project, '.team', 'tasks.md'), tasks)
    await writeFile(join(project, '.team', 'scripts', 'done.sh'), staleDone)
    await writeFile(join(project, '.mcp.json'), preexistingMcp)
    const result = run(project)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readFile(join(project, '.team', 'tasks.md'), 'utf8'), tasks)
    assert.equal(await readFile(join(project, '.team', 'scripts', 'done.sh'), 'utf8'), staleDone)
    assert.equal(await readFile(join(project, '.team', 'roles', 'member.md'), 'utf8'), await template('member-standalone.md'))
    assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), preexistingMcp)
    assert.equal(report(result).room_mcp.action, 'unchanged-preexisting')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertUnsafeSymlinkReject() {
  const project = await makeProject('peertable-assets-symlink-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'lattice',
    plan_key: 'fixture-plan',
    phases: [],
    added_root_mcp: true,
  })
  try {
    const sentinel = join(project, 'sentinel.txt')
    await writeFile(sentinel, 'must remain\n')
    await symlink(sentinel, join(project, '.team', 'scripts', 'start.sh'))
    const result = run(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /PEERTABLE_GENERATED_ASSET_UNSAFE_PATH/)
    assert.equal(await readFile(sentinel, 'utf8'), 'must remain\n')
    assert.equal(existsSync(join(project, '.team', 'scripts', 'done.sh')), false, 'preflight reject must not partially sync')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertInvalidStateReject() {
  const project = await makeProject('peertable-assets-invalid-state-', {
    room: 'fixture-room',
    server_url: 'http://127.0.0.1:1',
    mode: 'lattice',
    plan_key: '',
    phases: [],
  })
  try {
    const result = run(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /PEERTABLE_SETUP_STATE_INVALID/)
    assert.equal(existsSync(join(project, '.team', 'scripts', 'start.sh')), false)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertManagedMcpSymlinkReject() {
  const project = await makeProject('peertable-assets-mcp-symlink-', {
    room: 'fixture-room', server_url: 'http://127.0.0.1:1', mode: 'lattice',
    plan_key: 'fixture-plan', phases: [], added_root_mcp: true,
  })
  try {
    const sentinel = join(project, 'user-mcp.json')
    await writeFile(sentinel, '{"mcpServers":{"room":{"command":"user"}}}\n')
    await symlink(sentinel, join(project, '.mcp.json'))
    const result = run(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /PEERTABLE_GENERATED_ASSET_UNSAFE_PATH/)
    assert.equal(await readFile(sentinel, 'utf8'), '{"mcpServers":{"room":{"command":"user"}}}\n')
    assert.equal(existsSync(join(project, '.team', 'CLAUDE.md')), false, 'MCP preflight reject must not partially sync')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertResumeUpgradesBeforeRoomWork() {
  const source = await readFile(join(repo, 'skill', 'scripts', 'resume.sh'), 'utf8')
  const upgradeAt = source.indexOf('"$script_dir/upgrade-team-assets.sh" "$proj"')
  const roomWorkAt = source.indexOf('seats_file="$proj/.team/resume-seats.json"')
  assert.ok(upgradeAt > 0 && roomWorkAt > upgradeAt, 'resume must upgrade managed assets/MCP before room work')
  const teardown = await readFile(join(repo, 'skill', 'scripts', 'teardown.sh'), 'utf8')
  const removeAt = teardown.indexOf('remove-managed-room-mcp.mjs')
  const teamRemoveAt = teardown.indexOf('rm -rf "$proj/.team"')
  assert.ok(removeAt > 0 && teamRemoveAt > removeAt, 'teardown must remove only room MCP before deleting team state')
}

async function assertManagedMcpOnlyRoomDeletesFile() {
  const project = await mkdtemp(join(tmpdir(), 'peertable-assets-mcp-delete-'))
  try {
    await writeFile(join(project, '.mcp.json'), `${JSON.stringify({
      mcpServers: { room: { command: 'node', args: [join(repo, 'room', 'client.mjs')] } },
    })}\n`)
    const removed = spawnSync(process.execPath, [removeManagedMcp, project], { encoding: 'utf8' })
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal(JSON.parse(removed.stdout).action, 'file-deleted')
    assert.equal(existsSync(join(project, '.mcp.json')), false)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertManagedMcpRemoveConflictPreservesFile() {
  const project = await mkdtemp(join(tmpdir(), 'peertable-assets-mcp-remove-conflict-'))
  try {
    const content = '{"mcpServers":{"room":{"command":"user-room"},"other":{"command":"keep"}}}\n'
    await writeFile(join(project, '.mcp.json'), content)
    const removed = spawnSync(process.execPath, [removeManagedMcp, project], { encoding: 'utf8' })
    assert.notEqual(removed.status, 0)
    assert.match(removed.stderr, /PEERTABLE_MANAGED_MCP_REMOVE_CONFLICT/)
    assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), content)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertManagedMcpInvalidJsonReject() {
  const project = await makeProject('peertable-assets-mcp-invalid-', {
    room: 'fixture-room', server_url: 'http://127.0.0.1:1', mode: 'lattice',
    plan_key: 'fixture-plan', phases: [], added_root_mcp: true,
  })
  try {
    await writeFile(join(project, '.mcp.json'), '{broken')
    const result = run(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /PEERTABLE_MANAGED_MCP_INVALID/)
    assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), '{broken')
    assert.equal(existsSync(join(project, '.team', 'CLAUDE.md')), false, 'invalid MCP must fail before writes')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertPreexistingMcpStaleReject() {
  const project = await makeProject('peertable-assets-mcp-preexisting-stale-', {
    room: 'fixture-room', server_url: 'http://127.0.0.1:1', mode: 'standalone',
    plan_key: '', phases: [], added_root_mcp: false,
  })
  try {
    const stale = '{"mcpServers":{"room":{"command":"user-room"}}}\n'
    await writeFile(join(project, '.mcp.json'), stale)
    const result = run(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /PEERTABLE_PREEXISTING_MCP_STALE/)
    assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), stale)
    assert.equal(existsSync(join(project, '.team', 'CLAUDE.md')), false, 'stale preexisting MCP must fail before writes')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function assertSharedEnsureRoomMcpContract() {
  const project = await mkdtemp(join(tmpdir(), 'peertable-ensure-mcp-'))
  try {
    await writeFile(join(project, '.mcp.json'), `${JSON.stringify({
      mcpServers: { room: { command: 'node', args: ['C:\\old\\room\\client.mjs'] },
        other: { command: 'keep' } },
    })}\n`)
    const managed = spawnSync(process.execPath, [ensureRoomMcp, project, repo, 'managed'], { encoding: 'utf8' })
    assert.equal(managed.status, 0, managed.stderr)
    const config = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'))
    assert.deepEqual(config.mcpServers.room, { command: 'node', args: [join(repo, 'room', 'client.mjs')] })
    assert.deepEqual(config.mcpServers.other, { command: 'keep' })
    config.mcpServers.room = { command: 'user-room' }
    await writeFile(join(project, '.mcp.json'), `${JSON.stringify(config)}\n`)
    const preexisting = spawnSync(process.execPath,
      [ensureRoomMcp, project, repo, 'preexisting'], { encoding: 'utf8' })
    assert.notEqual(preexisting.status, 0)
    assert.match(preexisting.stderr, /SEAT_ROOM_MCP_STALE/)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

try {
  await assertLatticePositive()
  await assertStandaloneBoundary()
  await assertUnsafeSymlinkReject()
  await assertInvalidStateReject()
  await assertManagedMcpSymlinkReject()
  await assertResumeUpgradesBeforeRoomWork()
  await assertManagedMcpInvalidJsonReject()
  await assertPreexistingMcpStaleReject()
  await assertManagedMcpOnlyRoomDeletesFile()
  await assertManagedMcpRemoveConflictPreservesFile()
  await assertSharedEnsureRoomMcpContract()
  console.log(JSON.stringify({
    schema: 'peertable.generated_assets_upgrade_repro.v1',
    result: 'pass',
    cases: ['lattice-positive-idempotent', 'managed-room-mcp-upgrade', 'preexisting-room-mcp-preserved',
      'preexisting-room-mcp-stale-reject', 'teardown-room-block-only-preserves-other',
      'teardown-room-only-file-deleted',
      'teardown-room-conflict-preserved',
      'shared-ensure-room-mcp-contract',
      'standalone-boundary', 'unsafe-symlink-reject', 'invalid-setup-state-reject',
      'managed-room-mcp-symlink-reject', 'managed-room-mcp-invalid-json-reject',
      'resume-upgrade-before-room-work'],
  }))
} catch (error) {
  console.error(error.stack ?? error)
  process.exitCode = 1
}
