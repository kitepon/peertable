import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { scaffoldProject, runScript } from './project-scaffold.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-project-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const project = join(dir, 'project with spaces')
  mkdirSync(project)
  execFileSync('git', ['init', '--quiet', project])
  const tasks = join(dir, 'tasks.md')
  writeFileSync(tasks, '- smoke: 導入の確認\n')
  return { dir, project, tasks, room: 'install-smoke', url: 'http://127.0.0.1:18860' }
}

test('scaffoldは対象projectに生成し既存MCP設定と他projectを保持する', t => {
  const options = fixture(t)
  const mcp = { custom: true, mcpServers: { existing: { command: 'keep', args: ['a'] } } }
  writeFileSync(join(options.project, '.mcp.json'), JSON.stringify(mcp))
  mkdirSync(join(options.dir, 'other'))
  writeFileSync(join(options.dir, 'other', 'setting'), '保持')
  const result = scaffoldProject(options)
  assert.equal(result.action, 'created')
  assert.equal(result.state.mode, 'standalone')
  assert.equal(result.state.added_root_mcp, false)
  assert.equal(result.state.room_mcp_managed, true)
  const after = JSON.parse(readFileSync(join(options.project, '.mcp.json'), 'utf8'))
  assert.deepEqual(after.mcpServers.existing, mcp.mcpServers.existing)
  assert.equal(after.custom, true)
  assert.equal(after.mcpServers.room.command, 'node')
  assert.equal(readFileSync(join(options.dir, 'other', 'setting'), 'utf8'), '保持')
  assert.ok(existsSync(join(options.project, '.team', 'roles', 'member.md')))
})

test('setup再実行は既存roomと議題を保持してresumeを選ぶ', t => {
  const options = fixture(t)
  scaffoldProject(options)
  const path = join(options.project, '.team', 'tasks.md')
  const tasksBefore = readFileSync(path, 'utf8')
  writeFileSync(options.tasks, '新しい議題')
  const result = scaffoldProject({ project: options.project, tasks: options.tasks })
  assert.equal(result.action, 'resume')
  assert.equal(result.state.room, options.room)
  assert.equal(readFileSync(path, 'utf8'), tasksBefore)
  assert.throws(() => scaffoldProject({ project: options.project, room: 'different' }), { code: 'PEERTABLE_SETUP_TARGET_CONFLICT' })
  assert.throws(() => scaffoldProject({ project: options.project, url: 'http://elsewhere' }), { code: 'PEERTABLE_SETUP_TARGET_CONFLICT' })
})

test('既存team・room設定の衝突は書込み前に拒否する', t => {
  const options = fixture(t)
  writeFileSync(join(options.project, '.mcp.json'), '{"mcpServers":{"room":{"command":"user-owned"}}}')
  assert.throws(() => scaffoldProject(options), { code: 'PEERTABLE_MCP_CONFLICT' })
  assert.equal(existsSync(join(options.project, '.team')), false)
  rmSync(join(options.project, '.mcp.json'))
  mkdirSync(join(options.project, '.team'))
  writeFileSync(join(options.project, '.team', 'owned'), '独自資産')
  assert.throws(() => scaffoldProject(options), { code: 'PEERTABLE_SETUP_TEAM_CONFLICT' })
  assert.equal(readFileSync(join(options.project, '.team', 'owned'), 'utf8'), '独自資産')
})

test('team symlinkへ既存状態をたどらず、別projectへ書かない', t => {
  const options = fixture(t)
  const target = join(options.dir, 'outside')
  mkdirSync(target)
  writeFileSync(join(target, 'setup-state.json'), '{"mode":"standalone","room":"outside","server_url":"http://localhost"}')
  symlinkSync(target, join(options.project, '.team'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => scaffoldProject(options), { code: 'PEERTABLE_SETUP_TEAM_CONFLICT' })
})

test('単独modeの議題と明示projectを要求する', t => {
  const options = fixture(t)
  assert.throws(() => scaffoldProject({}), { code: 'PEERTABLE_PROJECT_REQUIRED' })
  assert.throws(() => scaffoldProject({ ...options, tasks: undefined }), { code: 'PEERTABLE_TASKS_REQUIRED' })
  assert.equal(existsSync(join(options.project, '.team')), false)
})
test('room block撤去は元の書式を戻し、運用中の他設定変更は保持する', t => {
  for (const original of ['{ "mcpServers": {} }', '{"custom":true,"mcpServers":{"existing":{"command":"keep"}}}']) {
    for (const changed of [false, true]) {
      const options = fixture(t)
      const file = join(options.project, '.mcp.json')
      writeFileSync(file, original)
      scaffoldProject(options)
      if (changed) {
        const current = JSON.parse(readFileSync(file, 'utf8'))
        current.added_by_user = '運用中の変更'
        writeFileSync(file, JSON.stringify(current))
      }
      runScript('remove-managed-room-mcp.mjs', [options.project])
      const actual = readFileSync(file, 'utf8')
      if (!changed) assert.equal(actual, original)
      else {
        assert.equal(JSON.parse(actual).added_by_user, '運用中の変更')
        assert.equal(JSON.parse(actual).mcpServers?.room, undefined)
      }
    }
  }
})
test('所有記録とMCP設定の書込み失敗から既存設定を保って再開する', t => {
  for (const point of ['setup-state.json', '.mcp.json.peertable-']) {
    const options = fixture(t)
    const file = join(options.project, '.mcp.json')
    const original = '{ "mcpServers": {} }\n'
    writeFileSync(file, original)
    const write = fs.writeFileSync
    try {
      fs.writeFileSync = (path, ...args) => {
        if (String(path).includes(point)) throw Object.assign(new Error('注入した書込み失敗'), { code: 'ENOSPC' })
        return write(path, ...args)
      }
      syncBuiltinESMExports()
      assert.throws(() => scaffoldProject(options), { code: 'ENOSPC' })
    } finally {
      fs.writeFileSync = write
      syncBuiltinESMExports()
    }
    assert.equal(readFileSync(file, 'utf8'), original)
    const resumed = scaffoldProject(options)
    assert.equal(resumed.action, point === 'setup-state.json' ? 'created' : 'resume')
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).mcpServers.room)
    runScript('remove-managed-room-mcp.mjs', [options.project])
    assert.equal(readFileSync(file, 'utf8'), original)
  }
})
