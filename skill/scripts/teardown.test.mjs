import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teardownProject, archiveLog } from './teardown.mjs'

function fixture(t, { stopFails = false, roomFails = false } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'peertable-teardown-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  mkdirSync(join(project, '.team'))
  writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: 'r', server_url: 'http://example', mode: 'standalone', lattice_preexisting: true }))
  writeFileSync(join(project, '.team', 'alarm-bridge.json'), JSON.stringify({ pid: 99, aiterm_session_id: 'alarm' }))
  writeFileSync(join(project, '.mcp.json'), '{"mcpServers":{"other":{"command":"other"}}}')
  const events = []
  let sessions = [{ session_id: 'alarm' }, { session_id: 'other-project' }]
  return { project, events, dependencies: {
    api: { members: async () => [], request: async (path, options = {}) => {
      events.push(`${options.method || 'GET'} ${path}`)
      if (roomFails && path === 'archive') throw new Error('room通信失敗')
      return { messages: [] }
    } },
    aiterm: { sessions: async () => sessions, call: async (_name, args) => {
      events.push(`close ${args.session_id}`)
      sessions = sessions.filter(item => item.session_id !== args.session_id)
    } },
    runScript: (name, args) => {
      events.push(`${name} ${args.at(-1)}`)
      if (name === 'alarm-bridge.mjs' && stopFails) throw new Error('bridge停止失敗')
      return ''
    },
  }, sessions: () => sessions }
}

test('alarm停止と公開APIの閉鎖を終えてから足場を消し、他projectと設定を保つ', async t => {
  const f = fixture(t)
  const result = await teardownProject({ project: f.project }, f.dependencies)
  assert.equal(result.status, 'done')
  assert.ok(f.events.indexOf('alarm-bridge.mjs --stop') < f.events.indexOf('POST archive'))
  assert.equal(existsSync(join(f.project, '.team')), false)
  assert.equal(readFileSync(join(f.project, '.mcp.json'), 'utf8'), '{"mcpServers":{"other":{"command":"other"}}}')
  assert.deepEqual(f.sessions(), [{ session_id: 'other-project' }])
})
for (const failure of ['stopFails', 'roomFails']) test(`${failure}では再実行用の記録を保持する`, async t => {
  const f = fixture(t, { [failure]: true })
  await assert.rejects(teardownProject({ project: f.project }, f.dependencies))
  assert.equal(existsSync(join(f.project, '.team', 'setup-state.json')), true)
})
test('ログの控えは原本がroomに残ると明示し、日本語本文を保持する', async t => {
  const f = fixture(t)
  const file = await archiveLog({ request: async () => ({ messages: [{ seq: 1, from: 'alice', to: 'all', ts: 'now', body: '議論を保存' }] }) }, f.project, 'r')
  const log = readFileSync(file, 'utf8')
  assert.match(log, /原本はサーバーに残ります/)
  assert.match(log, /議論を保存/)
})
test('ログ保存先のI/O失敗でも再実行でき、roomを先に畳まない', async t => {
  const f = fixture(t)
  writeFileSync(join(f.project, 'docs'), '既存file')
  await assert.rejects(teardownProject({ project: f.project }, f.dependencies), { code: 'PEERTABLE_TEARDOWN_INCOMPLETE' })
  assert.equal(existsSync(join(f.project, '.team', 'setup-state.json')), true)
  assert.equal(f.events.includes('POST archive'), false)
})
