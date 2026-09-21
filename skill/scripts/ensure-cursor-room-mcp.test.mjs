import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCursorRoomMcp, removeCursorRoomMcp } from './ensure-cursor-room-mcp.mjs'
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
  assert.deepEqual(config.mcpServers.room, expectedRoomMcp(f.root))
  assert.deepEqual(config.mcpServers.other, { command: 'other' })
  assert.equal(existsSync(f.marker), true)
  assert.equal(removeCursorRoomMcp(f.project, f.root).status, 'removed')
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { mcpServers: { other: { command: 'other' } } })
  assert.equal(existsSync(f.marker), false)
})

test('同じroom定義を利用者が管理している時は所有せず撤去しない', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, '.cursor'))
  writeFileSync(f.file, JSON.stringify({ mcpServers: { room: expectedRoomMcp(f.root), other: { command: 'other' } } }))
  assert.equal(ensureCursorRoomMcp(f.project, f.root).status, 'preexisting')
  assert.equal(existsSync(f.marker), false)
  assert.equal(removeCursorRoomMcp(f.project, f.root).status, 'absent')
  assert.equal(readFileSync(f.file, 'utf8').includes('"room"'), true)
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
