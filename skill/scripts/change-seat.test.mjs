import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeSeat, validateTarget } from './change-seat.mjs'

const catalog = { claude: '--effort <level> (low, medium, high, max)',
  codex: JSON.stringify({ models: [{ slug: 'model-a', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }] }] }),
  grok: 'Available models:\n  - grok-a\n  * grok-b (default)' }
const catalogDependencies = { resolveCommand: (command, argv) => ({ command, argv }), execute: command => catalog[command] }

function fixture(t) {
  const project = mkdtempSync(join(tmpdir(), 'peertable-change-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  mkdirSync(join(project, '.team'))
  writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: 'room', server_url: 'http://example', mode: 'standalone' }))
  let member = { name: 'alice', harness: 'claude', vendor: 'claude', model: 'old', effort: 'high', roles: ['実装者'], mission: '使命', aiterm_session_id: 'seat' }
  const events = [], messages = []
  const observation = { exists: true, state: 'idle', harness_alive: true, process_identity: { pid: 42, started_identity: 'old-start' } }
  const dependencies = { ...catalogDependencies,
    runScript: () => '/資格path',
    api: {
      members: async () => [{ ...member }],
      request: async (path, options = {}) => {
        events.push({ path, options })
        if (path === 'members') { member = { ...member, ...options.body }; return member }
        if (options.method === 'POST') {
          const message = { ...options.body, seq: messages.length + 1 }
          messages.push(message)
          return message
        }
        return { messages }
      },
    },
    aiterm: {
      observe: async () => observation,
      structured: async (tool, args) => {
        events.push({ tool, args })
        return { session_id: args.session_id, model: args.model ?? member.model, reasoning_effort: args.reasoning_effort ?? member.effort }
      },
    },
    launchSeat: async options => {
      events.push({ launch: options })
      member = { ...member, model: options.model, harness: options.harness, vendor: options.harness, effort: options.effort }
    },
  }
  return { project, dependencies, events, messages, observation, member: () => member, options: { project, name: 'alice' } }
}

test('本人DMの定型検査をせず、model・effortの各変更を同じsessionへ渡し履歴を読む', async t => {
  for (const target of [{ model: 'new' }, { effort: 'max' }, { model: 'new', effort: 'max' }]) {
    const f = fixture(t)
    const result = await changeSeat({ ...f.options, ...target, reason: '自然文の依頼を親が判断' }, f.dependencies)
    assert.equal(result.status, 'changed')
    assert.equal(f.events.filter(event => event.launch).length, 0)
    assert.deepEqual(f.events.find(event => event.tool).args, { session_id: 'seat', ...(target.model ? { model: target.model } : {}), ...(target.effort ? { reasoning_effort: target.effort } : {}) })
    assert.equal(f.member().model, target.model ?? 'old')
    assert.equal(f.member().effort, target.effort ?? 'high')
    assert.equal(f.messages.length, 1)
    assert.match(f.messages[0].body, /自然文の依頼を親が判断/)
  }
})
test('同値はAPI変更なし、busy・未知harnessは席を触らない', async t => {
  const f = fixture(t)
  assert.equal((await changeSeat({ ...f.options, effort: 'high' }, f.dependencies)).status, 'unchanged')
  f.observation.state = 'busy'
  await assert.rejects(changeSeat({ ...f.options, effort: 'max' }, f.dependencies), { code: 'SEAT_CHANGE_SEAT_BUSY' })
  await assert.rejects(changeSeat({ ...f.options, harness: 'unknown', model: 'x', effort: 'high' }, f.dependencies), { code: 'SEAT_CHANGE_HARNESS_UNSUPPORTED' })
  assert.equal(f.events.length, 0)
})
test('公式catalogの未知値と取得失敗は固定値へ置き換えない', () => {
  validateTarget('codex', 'model-a', 'max', catalogDependencies)
  validateTarget('grok', 'grok-b', 'high', catalogDependencies)
  assert.throws(() => validateTarget('claude', 'x', 'ultra', catalogDependencies), { code: 'SEAT_CHANGE_EFFORT_UNSUPPORTED' })
  assert.throws(() => validateTarget('codex', 'missing', 'max', catalogDependencies), { code: 'SEAT_CHANGE_MODEL_UNSUPPORTED' })
  assert.throws(() => validateTarget('codex', 'model-a', 'ultra', catalogDependencies), { code: 'SEAT_CHANGE_EFFORT_UNSUPPORTED' })
  assert.throws(() => validateTarget('grok', 'missing', 'high', catalogDependencies), { code: 'SEAT_CHANGE_MODEL_UNSUPPORTED' })
  assert.throws(() => validateTarget('claude', 'x', 'high', { ...catalogDependencies, execute: () => { throw new Error('catalog取得失敗') } }), /catalog取得失敗/)
})
test('configure失敗と応答不一致はmetadataを変更せず再起動もしない', async t => {
  for (const fail of [true, false]) {
    const f = fixture(t)
    f.dependencies.aiterm.structured = async () => { if (fail) throw new Error('configure失敗'); return { session_id: 'other', reasoning_effort: 'max' } }
    await assert.rejects(changeSeat({ ...f.options, effort: 'max' }, f.dependencies), fail ? /configure失敗/ : { code: 'SEAT_CHANGE_AITERM_RESULT_MISMATCH' })
    assert.equal(f.member().effort, 'high')
    assert.equal(f.events.length, 0)
  }
})
test('harness交代は役割とmissionを保って一度再着任し、履歴を一度残す', async t => {
  const f = fixture(t)
  await changeSeat({ ...f.options, harness: 'codex', model: 'model-a', effort: 'max' }, f.dependencies)
  const launches = f.events.filter(event => event.launch)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].launch.roles, '実装者')
  assert.equal(launches[0].launch.mission, '使命')
  assert.equal(f.messages.length, 1)
  assert.equal(f.member().harness, 'codex')
})
test('既存席を止める前の失敗はそのまま返し、席を失った時だけ旧設定へ一度復旧する', async t => {
  for (const stopped of [false, true]) {
    const f = fixture(t)
    let launches = 0
    f.dependencies.launchSeat = async () => {
      launches++
      if (launches === 1) {
        if (stopped) { f.observation.exists = false; f.observation.harness_alive = false }
        throw new Error('着任失敗')
      }
    }
    await assert.rejects(changeSeat({ ...f.options, harness: 'codex', model: 'model-a', effort: 'max' }, f.dependencies), stopped ? { code: 'SEAT_CHANGE_ROLLED_BACK' } : /着任失敗/)
    assert.equal(launches, stopped ? 2 : 1)
    assert.equal(f.messages.length, 0)
  }
})
test('台帳・履歴の読返し不一致は変更成立を装わない', async t => {
  for (const broken of ['metadata', 'history']) {
    const f = fixture(t)
    const request = f.dependencies.api.request
    f.dependencies.api.request = async (path, options) => {
      if (broken === 'metadata' && path === 'members') return {}
      if (broken === 'history' && path === 'messages' && !options) return { messages: [] }
      return request(path, options)
    }
    await assert.rejects(changeSeat({ ...f.options, effort: 'max' }, f.dependencies), {
      code: broken === 'metadata' ? 'SEAT_CHANGE_CHANGED_BUT_UNVERIFIED' : 'SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED',
    })
  }
})
