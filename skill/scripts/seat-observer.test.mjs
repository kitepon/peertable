import test from 'node:test'
import assert from 'node:assert/strict'
import { SeatObserver } from './seat-observer.mjs'

const result = (state, activity = {}) => ({ state, exists: state !== 'missing', pane_alive: true, token_hint: 1200,
  process_identity: { pid: 42 }, activity: { cursor: 'opaque', output_changed: null, cpu_delta_seconds: null, background_cpu_delta_seconds: null, ...activity } })
function fixture(extra = [], observations = {}) {
  const member = { name: 'alice', aiterm_session_id: 'seat' }
  const calls = []
  const aiterm = {
    sessions: async () => [{ session_id: 'seat', environment: { PEERTABLE_MEMBER: 'alice', PEERTABLE_ROOM: 'r' } }, ...extra],
    observe: async (id, cursor) => { calls.push({ id, cursor }); return observations[id] ?? result('idle') },
  }
  return { observer: new SeatObserver(aiterm, 'r'), member, calls }
}
test('Aitermの状態とtokenを渡し、opaque cursorを再観測へ返す', async () => {
  const f = fixture([], { seat: result('blocked') })
  const first = await f.observer.cycle([f.member], new Map(), 'time')
  assert.equal(first.get('alice').status, 'blocked')
  assert.equal(first.get('alice').paneTokenHint, 1200)
  await f.observer.cycle([f.member], first, 'later')
  assert.equal(f.calls[1].cursor, 'opaque')
})
test('roomが一致する預け仕事だけを合成し、番犬用の席状態を保つ', async () => {
  const f = fixture([
    { session_id: 'job', environment: { PEERTABLE_MEMBER: 'alice', PEERTABLE_ROOM: 'r' } },
    { session_id: 'elsewhere', environment: { PEERTABLE_MEMBER: 'alice', PEERTABLE_ROOM: 'other' } },
  ], { job: result('unknown', { output_changed: true }) })
  const row = (await f.observer.cycle([f.member], new Map(), 'time')).get('alice')
  assert.equal(row.status, 'busy')
  assert.equal(row.paneStatus, 'idle')
  assert.deepEqual(f.calls.map(x => x.id), ['seat', 'job'])
})
test('足場CPUを稼働に数えず、席内background CPUを稼働へ合成する', async () => {
  for (const [background, expected] of [[null, 'idle'], [0.01, 'busy']]) {
    const f = fixture([], { seat: result('idle', { cpu_delta_seconds: 0.3, background_cpu_delta_seconds: background }) })
    assert.equal((await f.observer.cycle([f.member], new Map(), 'time')).get('alice').status, expected)
  }
})
test('消失はdead、観測失敗は例外になりidleへ丸めない', async () => {
  const f = fixture([], { seat: result('missing') })
  assert.equal((await f.observer.cycle([f.member], new Map(), 'time')).get('alice').status, 'dead')
  f.observer.aiterm.observe = async () => { throw new Error('API failure') }
  await assert.rejects(f.observer.cycle([f.member], new Map(), 'time'), /API failure/)
})
test('他roomの身元不一致を明示し、同じ観測回の正常席を残す', async () => {
  const f = fixture([{ session_id: 'wrong', environment: { PEERTABLE_MEMBER: 'bob', PEERTABLE_ROOM: 'other' } }])
  const rows = await f.observer.cycle([f.member, { name: 'bob', aiterm_session_id: 'wrong' }], new Map(), 'time')
  assert.equal(rows.get('alice').status, 'idle')
  assert.equal(rows.get('bob').error.code, 'PEERTABLE_SEAT_SESSION_IDENTITY_CONFLICT')
  assert.deepEqual(f.calls.map(call => call.id), ['seat'])
})
test('harnessのnative停止はblockedとして保持する', async () => {
  const f = fixture([], { seat: { ...result('blocked'), reason: 'harness_stopped', pane_alive: true, harness_alive: true } })
  const row = (await f.observer.cycle([f.member], new Map(), 'time')).get('alice')
  assert.equal(row.status, 'blocked')
  assert.equal(row.paneStatus, 'blocked')
})
