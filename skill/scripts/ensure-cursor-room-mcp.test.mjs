import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCursorRoomMcp, expectedCursorRoomMcp, removeCursorRoomMcp } from './ensure-cursor-room-mcp.mjs'
import { expectedRoomMcp } from './room-mcp-config.mjs'

function fixture(t) {
  const project = mkdtempSync(join(tmpdir(), 'peertable-cursor-mcp-'))
  const root = join(project, 'peertable')
  mkdirSync(join(project, '.team'), { recursive: true })
  mkdirSync(join(root, 'room'), { recursive: true })
  t.after(() => rmSync(project, { recursive: true, force: true }))
  return { project, root, file: join(project, '.cursor', 'mcp.json'), marker: join(project, '.team', 'cursor-room-mcp.managed.json') }
}

test('Cursorのproject MCPへroomだけを追加し、既存serverを保って撤去する', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, '.cursor'))
  writeFileSync(f.file, JSON.stringify({ mcpServers: { other: { command: 'other' } } }))
  const ensured = ensureCursorRoomMcp(f.project, f.root)
  assert.equal(ensured.status, 'managed')
  const config = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.deepEqual(config.mcpServers.room, expectedCursorRoomMcp(f.root))
  assert.deepEqual(config.mcpServers.room.env, Object.fromEntries([
    'PEERTABLE_URL', 'PEERTABLE_ROOM', 'PEERTABLE_MEMBER', 'PEERTABLE_CREDENTIAL_FILE',
    'PEERTABLE_HARNESS', 'PEERTABLE_VENDOR', 'PEERTABLE_MODEL', 'PEERTABLE_EFFORT',
    'PEERTABLE_ROLE', 'PEERTABLE_ROLES', 'PEERTABLE_MISSION', 'AITERM_SESSION_ID',
  ].map(key => [key, '${env:' + key + '}'])))
  assert.equal(config.mcpServers.room.env.PEERTABLE_POST_TOKEN, undefined)
  assert.equal(config.mcpServers.room.env.PEERTABLE_CREDENTIAL_FILE, '${env:PEERTABLE_CREDENTIAL_FILE}')
  assert.deepEqual(config.mcpServers.other, { command: 'other' })
  assert.equal(existsSync(f.marker), true)
  assert.equal(removeCursorRoomMcp(f.project, f.root).status, 'removed')
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { mcpServers: { other: { command: 'other' } } })
  assert.equal(existsSync(f.marker), false)
})

test('同じroom定義を利用者が管理している時は所有せず撤去しない', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, '.cursor'))
  writeFileSync(f.file, JSON.stringify({ mcpServers: { room: expectedCursorRoomMcp(f.root), other: { command: 'other' } } }))
  assert.equal(ensureCursorRoomMcp(f.project, f.root).status, 'preexisting')
  assert.equal(existsSync(f.marker), false)
  assert.equal(removeCursorRoomMcp(f.project, f.root).status, 'absent')
  assert.equal(readFileSync(f.file, 'utf8').includes('"room"'), true)
})

test('管理marker付きlegacy定義だけをenv補間へ移行し、markerと他設定を保つ', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, '.cursor'))
  const marker = { schema: 'peertable.cursor-room-mcp.v1', added_exclude: false }
  writeFileSync(f.marker, JSON.stringify(marker))
  writeFileSync(f.file, JSON.stringify({ setting: 'keep', mcpServers: { room: expectedRoomMcp(f.root), other: { command: 'other' } } }))
  assert.equal(ensureCursorRoomMcp(f.project, f.root).status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(f.file)), { setting: 'keep', mcpServers: { room: expectedCursorRoomMcp(f.root), other: { command: 'other' } } })
  assert.deepEqual(JSON.parse(readFileSync(f.marker)), marker)
  assert.equal(ensureCursorRoomMcp(f.project, f.root).status, 'ready')
})

test('利用者管理のlegacyと管理後に編集されたenvを上書きしない', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, '.cursor'))
  const legacy = JSON.stringify({ mcpServers: { room: expectedRoomMcp(f.root) } })
  writeFileSync(f.file, legacy)
  assert.throws(() => ensureCursorRoomMcp(f.project, f.root), { code: 'SEAT_CURSOR_ROOM_MCP_CONFLICT' })
  assert.equal(readFileSync(f.file, 'utf8'), legacy)
  assert.equal(removeCursorRoomMcp(f.project, f.root).status, 'absent')
  writeFileSync(f.marker, JSON.stringify({ schema: 'peertable.cursor-room-mcp.v1', added_exclude: false }))
  const edited = expectedCursorRoomMcp(f.root)
  edited.env.PEERTABLE_MEMBER = '利用者の席'
  const body = JSON.stringify({ mcpServers: { room: edited } })
  writeFileSync(f.file, body)
  assert.throws(() => ensureCursorRoomMcp(f.project, f.root), { code: 'SEAT_CURSOR_ROOM_MCP_CONFLICT' })
  assert.throws(() => removeCursorRoomMcp(f.project, f.root), { code: 'SEAT_CURSOR_ROOM_MCP_OWNERSHIP_CONFLICT' })
  assert.equal(readFileSync(f.file, 'utf8'), body)
})

test('旧管理定義も撤去し、利用者の他serverを残す', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, '.cursor'))
  writeFileSync(f.marker, JSON.stringify({ schema: 'peertable.cursor-room-mcp.v1', added_exclude: false }))
  writeFileSync(f.file, JSON.stringify({ mcpServers: { room: expectedRoomMcp(f.root), other: { command: 'other' } } }))
  assert.equal(removeCursorRoomMcp(f.project, f.root).status, 'removed')
  assert.deepEqual(JSON.parse(readFileSync(f.file)), { mcpServers: { other: { command: 'other' } } })
  assert.equal(existsSync(f.marker), false)
})

test('異なるroom定義と管理後の手編集は明示errorにする', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, '.cursor'))
  writeFileSync(f.file, JSON.stringify({ mcpServers: { room: { command: 'other' } } }))
  assert.throws(() => ensureCursorRoomMcp(f.project, f.root), { code: 'SEAT_CURSOR_ROOM_MCP_CONFLICT' })
  writeFileSync(f.file, JSON.stringify({ mcpServers: { other: { command: 'other' } } }))
  ensureCursorRoomMcp(f.project, f.root)
  writeFileSync(f.file, JSON.stringify({ mcpServers: { room: { command: 'changed' } } }))
  assert.throws(() => removeCursorRoomMcp(f.project, f.root), { code: 'SEAT_CURSOR_ROOM_MCP_OWNERSHIP_CONFLICT' })
})
