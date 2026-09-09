#!/usr/bin/env node
import assert from 'node:assert/strict'
import { seatSessionId, findSeatSession } from '../skill/scripts/seat-session.mjs'

assert.equal(seatSessionId({ name: 'codex', aiterm_session_id: 'seat-codex' }), 'seat-codex')
assert.equal(seatSessionId({ observe: { aiterm_session_id: 'seat-new', tmux_target: 'old' } }), 'seat-new')
assert.equal(seatSessionId({ observe: { tmux_socket: '/旧内部pathは使わない', tmux_target: 'old' } }), 'old')
assert.equal(seatSessionId({ name: 'codex' }), null)
const member = { name: 'codex', aiterm_session_id: 'seat' }
const session = { session_id: 'seat', environment: { PEERTABLE_MEMBER: 'codex', PEERTABLE_ROOM: 'room' } }
assert.equal(findSeatSession(member, [session], 'room'), session)
assert.throws(() => findSeatSession(member, [session], 'other'), { code: 'PEERTABLE_SEAT_SESSION_IDENTITY_CONFLICT' })
assert.equal(findSeatSession(member, [], 'room'), null)
console.log('公開session descriptor: 7件成功')
