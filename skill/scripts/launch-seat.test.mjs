import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchSeat } from './launch-seat.mjs'
import { runScript } from './project-scaffold.mjs'

function fixture(t, harness = 'claude') {
  const project = mkdtempSync(join(tmpdir(), 'peertable-launch-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  mkdirSync(join(project, '.team'))
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { room: { command: 'node' }, other: { command: 'other' } } }))
  writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: 'room', server_url: 'http://example', mode: 'standalone' }))
  const events = []
  const member = { name: 'alice', harness, model: 'fixture-model', roles: ['実装者'], aiterm_session_id: 'peer-alice', pid: 23 }
  const options = { project, name: 'alice', roles: '実装者', brief: '着任してください' }
  const dependencies = {
    resolveCommand: (command, argv) => ({ command, argv }),
    runScript: (file, args) => {
      events.push({ file, args })
      if (file === 'resolve-seat-placement.mjs') return JSON.stringify({ settings: { model: 'fixture-model', harness, effort: 'high' }, roles: ['実装者'] })
      return '/資格path'
    },
    execFileSync: () => { events.push({ preflight: true }) },
    leaveSeat: async (_project, _name, rollback) => { events.push({ leave: true, rollback: Boolean(rollback) }) },
    ensureProjectRuntime: async () => { events.push({ runtime: true }) },
    spawn: (executable, args) => {
      events.push({ wait: { executable, args } })
      const waiter = new EventEmitter()
      waiter.unref = () => {}
      return waiter
    },
    api: { members: async () => [member], request: async (path, options) => { events.push({ path, options }) } },
    aiterm: {
      sessions: async () => [],
      observe: async () => ({ state: 'busy', exists: true, harness_alive: true, process_identity: { pid: 23, started_identity: 'native-start', argv_digest: 'digest' }, observed_at: 'now' }),
      structured: async (tool, args) => {
        events.push({ tool, args })
        if (tool === 'agent_launch') return { session_id: 'peer-alice', startup: { status: 'ready' } }
        if (tool === 'agent_approval') return { status: 'none' }
        if (tool === 'pty_send') return { mode: 'agent_dispatch', event_cursor: 0, submit_residue: false, wait_process: { executable: 'opaque-waiter', args: ['opaque-cursor'] } }
        throw new Error(`予期しないAPI: ${tool}`)
      },
    },
  }
  return { options, dependencies, events, member }
}

test('起動準備・登録・runtimeの成立後に長い日本語briefを一度だけ公開APIへ渡す', async t => {
  const f = fixture(t)
  f.options.brief = '長い着任指示。'.repeat(2000)
  const result = await launchSeat(f.options, f.dependencies)
  assert.equal(result.status, 'ready')
  assert.equal(result.turn_started, true)
  const sent = f.events.filter(event => event.tool === 'pty_send')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].args.text, f.options.brief)
  assert.ok(f.events.findIndex(event => event.runtime) < f.events.indexOf(sent[0]))
  const launch = f.events.find(event => event.tool === 'agent_launch')
  assert.equal(launch.args.trust_project, true)
  assert.equal(Object.hasOwn(launch.args, 'prompt'), false)
  assert.equal(launch.args.env_vars.includes('PEERTABLE_POST_TOKEN'), false)
  assert.deepEqual(f.events.find(event => event.wait).wait, { executable: 'opaque-waiter', args: ['opaque-cursor'] })
})

test('モデル実測失敗とサイズ超過は既存席へ触らない', async t => {
  const f = fixture(t)
  f.dependencies.execFileSync = () => { throw new Error('モデル利用不可') }
  await assert.rejects(launchSeat(f.options, f.dependencies), /モデル利用不可/)
  assert.equal(f.events.some(event => event.leave), false)
  f.events.length = 0
  await assert.rejects(launchSeat({ ...f.options, brief: 'あ'.repeat(22000) }, f.dependencies), { code: 'LAUNCH_BRIEF_TOO_LONG' })
  assert.equal(f.events.length, 0)
})

test('起動未確認と別sessionの応答ではbriefを送らず撤去する', async t => {
  for (const receipt of [{ session_id: 'peer-alice', startup: { status: 'not_checked' } }, { session_id: 'other', startup: { status: 'ready' } }]) {
    const f = fixture(t)
    f.dependencies.aiterm.structured = async (tool) => {
      assert.equal(tool, 'agent_launch')
      return receipt
    }
    await assert.rejects(launchSeat(f.options, f.dependencies), { code: 'SEAT_STARTUP_NOT_READY' })
    assert.equal(f.events.filter(event => event.rollback).length, 1)
  }
})

test('送信後の不成立は再送せず、撤去失敗も消さず返す', async t => {
  const f = fixture(t)
  const structured = f.dependencies.aiterm.structured
  f.dependencies.aiterm.structured = async (tool, args) => tool === 'pty_send'
    ? { ...await structured(tool, args), submit_residue: true } : structured(tool, args)
  f.dependencies.leaveSeat = async (_project, _name, rollback) => { if (rollback) throw new Error('公開停止失敗') }
  await assert.rejects(launchSeat(f.options, f.dependencies), error => error instanceof AggregateError && /公開停止失敗/.test(error.message))
  assert.equal(f.events.filter(event => event.tool === 'pty_send').length, 1)
})

test('room台帳が不完全なら起動済みとして報告しない', async t => {
  const f = fixture(t)
  delete f.member.pid
  f.options.brief = ''
  await assert.rejects(launchSeat(f.options, f.dependencies), { code: 'SEAT_LEDGER_INCOMPLETE' })
  assert.equal(f.events.filter(event => event.rollback).length, 1)
})
test('TUI準備完了でもroom未登録なら成功せず撤去する', async t => {
  const f = fixture(t)
  t.mock.timers.enable({ apis: ['Date'] })
  f.dependencies.api.members = async () => {
    t.mock.timers.tick(90_001)
    return []
  }
  await assert.rejects(launchSeat(f.options, f.dependencies), { code: 'SEAT_ROOM_MCP_NOT_READY' })
  assert.equal(f.events.filter(event => event.rollback).length, 1)
  assert.equal(f.events.some(event => event.tool === 'pty_send'), false)
})
test('Lattice併用の席identityとactorを公開launcherのenvへ明示する', async t => {
  const f = fixture(t)
  writeFileSync(join(f.options.project, '.team', 'setup-state.json'), JSON.stringify({ room: 'room', server_url: 'http://example', mode: 'lattice', plan_key: 'plan' }))
  f.dependencies.ensureProjectRuntime = async (_project, { env }) => {
    assert.equal(env.PEERTABLE_PLAN, 'plan')
    assert.equal(env.LATTICE_TODO_ACTOR_SESSION, 'alice')
    assert.equal(env.LATTICE_TODO_ACTOR_AGENT, 'alice')
    assert.ok(env.LATTICE_TODO_ACTOR_HOST)
  }
  await launchSeat(f.options, f.dependencies)
  const keys = f.events.find(event => event.tool === 'agent_launch').args.env_vars
  for (const key of ['PEERTABLE_MEMBER', 'PEERTABLE_PLAN', 'LATTICE_CLI', 'LATTICE_TODO_ACTOR_HOST', 'LATTICE_TODO_ACTOR_SESSION', 'LATTICE_TODO_ACTOR_AGENT']) assert.ok(keys.includes(key), key)
})
test('CodexとGrokは席専用homeへ設定し、共有設定を保つ', async t => {
  for (const harness of ['codex', 'grok']) {
    const f = fixture(t, harness)
    const home = join(f.options.project, 'fixture-home')
    const shared = join(home, `.${harness}`)
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'auth.json'), '{"fixture":"auth"}')
    writeFileSync(join(shared, 'config.toml'), 'model = "shared-config"\n')
    f.dependencies.home = home
    const script = f.dependencies.runScript
    f.dependencies.runScript = (file, args, options) => ['grok-seat-config.mjs', 'ensure-codex-room-mcp.mjs'].includes(file)
      ? runScript(file, args, options) : script(file, args, options)
    let preflightHome
    f.dependencies.execFileSync = (_command, _args, options) => {
      if (harness !== 'grok') return
      preflightHome = options.env.GROK_HOME
      assert.notEqual(preflightHome, shared)
      assert.equal(readFileSync(join(preflightHome, 'auth.json'), 'utf8'), '{"fixture":"auth"}')
      assert.doesNotMatch(readFileSync(join(preflightHome, 'config.toml'), 'utf8'), /shared-config/)
    }
    await launchSeat(f.options, f.dependencies)
    assert.equal(readFileSync(join(shared, 'config.toml'), 'utf8'), 'model = "shared-config"\n')
    const privateHome = join(f.options.project, '.team', 'seats', harness === 'grok' ? 'alice.grok-home' : 'alice.codex')
    assert.equal(readFileSync(join(privateHome, 'auth.json'), 'utf8'), '{"fixture":"auth"}')
    assert.doesNotMatch(readFileSync(join(privateHome, 'config.toml'), 'utf8'), /shared-config/)
    if (preflightHome) assert.equal(existsSync(preflightHome), false)
    assert.ok(f.events.find(event => event.tool === 'agent_launch').args.env_vars.includes(harness === 'grok' ? 'GROK_HOME' : 'CODEX_HOME'))
  }
})
