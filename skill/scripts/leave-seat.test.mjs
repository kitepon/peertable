import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leaveSeat } from './leave-seat.mjs'

function fixture(t, failure) {
  const project = mkdtempSync(join(tmpdir(), 'peertable-leave-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  mkdirSync(join(project, '.team', 'seats', 'alice.grok-home'), { recursive: true })
  writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: 'room-a', server_url: 'http://localhost', mode: 'standalone' }))
  const token = join(project, '.team', 'token')
  writeFileSync(token, 'test')
  const events = []
  let members = [{ name: 'alice', aiterm_session_id: 'seat-a' }]
  let sessions = [{ session_id: 'seat-a', environment: { PEERTABLE_MEMBER: 'alice', PEERTABLE_ROOM: 'room-a' } }, { session_id: 'other', environment: { PEERTABLE_MEMBER: 'bob', PEERTABLE_ROOM: 'room-b' } }]
  const api = {
    members: async () => members,
    request: async (path, options) => { events.push(options.method); members = []; return {} },
  }
  const aiterm = {
    sessions: async () => { if (failure === 'list') throw new Error('API停止'); return sessions },
    call: async (tool, args) => { events.push(tool); if (failure === 'close') throw new Error('停止失敗'); sessions = sessions.filter(item => item.session_id !== args.session_id) },
  }
  const credentialCommand = (_script, args) => { if (args[0] === 'remove') { events.push('credential-remove'); rmSync(token) }; return token }
  return { project, token, events, api, aiterm, credentialCommand, sessions: () => sessions, members: () => members }
}

test('公開APIで停止を確認してから登録と秘密を消し、他のroomを保つ', async t => {
  const f = fixture(t)
  const result = await leaveSeat(f.project, 'alice', f)
  assert.equal(result.status, 'left')
  assert.deepEqual(f.events, ['pty_close', 'DELETE', 'credential-remove'])
  assert.deepEqual(f.sessions().map(item => item.session_id), ['other'])
  assert.equal(existsSync(f.token), false)
  assert.equal(existsSync(join(f.project, '.team', 'seats', 'alice.grok-home')), false)
})

for (const failure of ['list', 'close']) test(`Aitermの${failure}失敗では登録とcredentialを保つ`, async t => {
  const f = fixture(t, failure)
  await assert.rejects(leaveSeat(f.project, 'alice', f))
  assert.equal(f.members().length, 1)
  assert.equal(existsSync(f.token), true)
  assert.equal(f.events.includes('DELETE'), false)
})

test('同じ識別子でも別roomの席は停止しない', async t => {
  const f = fixture(t)
  f.sessions()[0].environment.PEERTABLE_ROOM = 'another-room'
  await assert.rejects(leaveSeat(f.project, 'alice', f), { code: 'PEERTABLE_SEAT_SESSION_IDENTITY_CONFLICT' })
  assert.deepEqual(f.events, [])
})
