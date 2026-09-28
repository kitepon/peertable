import test from 'node:test'
import assert from 'node:assert/strict'
import { seatsToResume, verifyProjectRuntime, resumeProject } from './project-runtime.mjs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectedRoomMcp } from './room-mcp-config.mjs'
import { expectedCursorRoomMcp } from './ensure-cursor-room-mcp.mjs'
import { packageRoot } from './install-skill.mjs'

const member = { name: 'alice', harness: 'codex', aiterm_session_id: 'seat', roles: ['実装者'] }
const sessions = [{ session_id: 'seat', environment: { PEERTABLE_MEMBER: 'alice', PEERTABLE_ROOM: 'room' } }]
test('sessionが残っていてもharness死亡なら復帰し、生存席は保つ', async () => {
  for (const [state, alive, count] of [['dead', false, 1], ['idle', true, 0], ['busy', true, 0]]) {
    const aiterm = { observe: async () => ({ exists: true, state, harness_alive: alive }) }
    assert.equal((await seatsToResume(aiterm, [member], sessions, 'room')).length, count)
  }
  assert.deepEqual(await seatsToResume({}, [member], [], 'room'), [member])
})
test('判定不能と役割不足は副作用前に明示し、親は復帰対象にしない', async () => {
  const aiterm = { observe: async () => ({ exists: true, state: 'unknown', harness_alive: null, reason: 'harness_process_unresolved' }) }
  await assert.rejects(seatsToResume(aiterm, [member], sessions, 'room'), { code: 'RESUME_MEMBER_OBSERVATION_UNKNOWN' })
  await assert.rejects(seatsToResume({}, [{ ...member, roles: [] }], [], 'room'), { code: 'RESUME_MEMBER_ROLES_MISSING' })
  assert.deepEqual(await seatsToResume({}, [{ ...member, delivery: { kind: 'parent_watch' } }], [], 'room'), [])
})
test('fresh heartbeatと宛先別deliveredを読んで再開の配達を確認する', async () => {
  const calls = []
  const api = { members: async () => [{ ...member, status_reason: 'fresh' }], request: async (path, options) => {
    calls.push({ path, options })
    return path === 'messages' ? { seq: 7 } : { delivery: { alice: { state: 'delivered' } } }
  } }
  assert.deepEqual(await verifyProjectRuntime(api), { heartbeat: 1, probe: 'delivered', seq: 7 })
  assert.equal(calls[0].options.body.to, 'alice')
  assert.equal(calls[1].path, 'deliveries?seq=7')
})

test('resumeは未登録席の管理markerと生存Cursor席の両方でMCP設定をruntime確認前に更新する', async t => {
  for (const managedLegacy of [true, false]) {
    const project = mkdtempSync(join(tmpdir(), 'peertable-resume-cursor-'))
    t.after(() => rmSync(project, { recursive: true, force: true }))
    mkdirSync(join(project, '.team'))
    writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: 'room', server_url: 'http://fixture', mode: 'standalone', room_mcp_managed: true }))
    if (managedLegacy) {
      mkdirSync(join(project, '.cursor'))
      writeFileSync(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { room: expectedRoomMcp(packageRoot) } }))
      writeFileSync(join(project, '.team', 'cursor-room-mcp.managed.json'), JSON.stringify({ schema: 'peertable.cursor-room-mcp.v1', added_exclude: false }))
    }
    const members = managedLegacy ? [] : [{ ...member, harness: 'cursor', status_reason: 'fresh' }]
    let runtimeChecked = false
    let connected = false
    const result = await resumeProject({ project, probe: false }, {
      aiterm: { sessions: async () => sessions, observe: async () => ({ exists: true, harness_alive: true, state: 'idle' }) },
      api: { members: async () => members },
      runScript: () => 'fixture-credential-path',
      connectCommand: async () => { connected = true; return { status: 'registered' } },
      ensureProjectRuntime: async () => {
        assert.equal(connected, true)
        assert.deepEqual(JSON.parse(readFileSync(join(project, '.cursor', 'mcp.json'))).mcpServers.room, expectedCursorRoomMcp(packageRoot))
        assert.deepEqual(JSON.parse(readFileSync(join(project, '.mcp.json'))).mcpServers.room, expectedRoomMcp(packageRoot))
        runtimeChecked = true
        return { status: 'ready' }
      },
    })
    assert.equal(runtimeChecked, true)
    assert.equal(result.status, 'ready')
    assert.deepEqual(result.relaunched, [])
  }
})
