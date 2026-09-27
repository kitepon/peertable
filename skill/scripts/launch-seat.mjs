// 正規着座。TUIの準備・入力・観測はAiterm、席の設定・台帳はPeertableが所有する。
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermClient } from './aiterm-client.mjs'
import { RoomApi } from './room-api.mjs'
import { passSeatApproval } from './seat-approval.mjs'
import { leaveSeat } from './leave-seat.mjs'
import { ensureProjectRuntime } from './ensure-project-runtime.mjs'
import { projectPath, readSetup, runScript, fail } from './project-scaffold.mjs'
import { packageRoot } from './install-skill.mjs'
import { resolveWindowsCommand } from './platform/windows/resolve-lattice-command.mjs'
import { beginSeatLaunch, endSeatLaunch } from './seat-launch-phase.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const harnessIds = { claude: 'claude-code', codex: 'codex-cli', grok: 'grok-cli', cursor: 'cursor-cli' }

function prepareHarness(project, name, harness, env, script, home) {
  if (harness === 'grok' || harness === 'codex') {
    const key = harness === 'grok' ? 'GROK_HOME' : 'CODEX_HOME'
    env[key] = join(project, '.team', 'seats', name + (harness === 'grok' ? '.grok-home' : '.codex'))
    mkdirSync(env[key], { recursive: true })
    const auth = join(home, `.${harness}`, 'auth.json')
    if (existsSync(auth)) {
      copyFileSync(auth, join(env[key], 'auth.json'))
      chmodSync(join(env[key], 'auth.json'), 0o600)
    } else if (harness === 'grok') fail('SEAT_GROK_AUTH_MISSING', 'Grokの認証がありません')
    if (harness === 'grok') script('grok-seat-config.mjs', [project, join(env[key], 'config.toml')], { env })
    else script('ensure-codex-room-mcp.mjs', ['ensure', project, packageRoot], { env })
  } else if (harness === 'cursor') {
    // Cursor Agent CLIへは席情報をenv補間で明示する。設定を席ごとに書き換えない。
    script('ensure-cursor-room-mcp.mjs', ['ensure', project, packageRoot], { env })
  }
}

async function preflightCursor(project, name, model, effort, env, dependencies) {
  const sessionId = `peer-${name}-preflight`
  const ownAiterm = !dependencies.aiterm
  const aiterm = dependencies.aiterm ?? new AitermClient({ env })
  let attempted = false
  let sessionStarted = false
  try {
    if ((await aiterm.sessions()).some(session => session.session_id === sessionId))
      fail('SEAT_SESSION_CONFLICT', `${sessionId} が既に存在します`)
    attempted = true
    const launch = await aiterm.structured('agent_launch', {
      session_name: sessionId, harness: 'cursor-cli', model, reasoning_effort: effort,
      cwd: project, trust_project: true,
    }, 'aiterm.agent-launch-result.v1')
    sessionStarted = launch.session_id === sessionId
    if (launch.session_id !== sessionId || launch.startup?.status !== 'ready') {
      fail('SEAT_STARTUP_NOT_READY', `${name} のCursor model確認が完了していません: ${launch.startup?.reason ?? 'startup応答なし'}`)
    }
  } finally {
    if (sessionStarted || (attempted && (await aiterm.sessions()).some(session => session.session_id === sessionId))) {
      await aiterm.call('pty_close', { session_id: sessionId })
      if ((await aiterm.sessions()).some(session => session.session_id === sessionId))
        fail('SEAT_PREFLIGHT_SESSION_FAILED', `${sessionId} が停止後も残っています`)
    }
    if (ownAiterm) await aiterm.close()
  }
}

export async function launchSeat(options, dependencies = {}) {
  if (process.env.PEERTABLE_MEMBER) fail('SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN', '席から別席は起動できません')
  const project = projectPath(options.project)
  const { name, brief = '' } = options
  if (!name || !/^[A-Za-z0-9._:-]+$/.test(name)) fail('SEAT_LAUNCH_ARGS_INVALID', '有効な席名を指定してください')
  if (!options.roles) fail('SEAT_LAUNCH_ARGS_INVALID', '役割を指定してください')
  if (Buffer.byteLength(brief) > 65536) fail('LAUNCH_BRIEF_TOO_LONG', '着任指示の上限は65536 bytesです')
  const env = { ...process.env }
  const home = dependencies.home ?? homedir()
  const script = dependencies.runScript ?? runScript
  const execute = dependencies.execFileSync ?? execFileSync
  const leave = dependencies.leaveSeat ?? leaveSeat
  const ensureRuntime = dependencies.ensureProjectRuntime ?? ensureProjectRuntime
  delete env.PEERTABLE_POST_TOKEN
  delete env.PEERTABLE_TMUX_SOCKET
  const placementArgs = ['--roles', options.roles]
  for (const key of ['model', 'effort', 'harness']) if (options[key]) placementArgs.push(`--${key}`, options[key])
  const placement = JSON.parse(script('resolve-seat-placement.mjs', placementArgs, { env }))
  const { model, harness, effort } = placement.settings
  if (!harnessIds[harness]) fail('SEAT_LAUNCH_HARNESS_UNSUPPORTED', harness)
  script('upgrade-team-assets.mjs', [project], { env })
  const state = readSetup(project)
  // 既存席を畳む前にmodelを実測する。Cursorのcatalog・ID方言はAitermだけが所有する。
  if (harness === 'cursor') await preflightCursor(project, name, model, effort, env, dependencies)
  else {
    const preflightArgs = harness === 'codex' ? ['exec', '--model', model, '--skip-git-repo-check', 'ping']
      : harness === 'grok' ? ['--model', model, '--reasoning-effort', effort, '-p', 'ping'] : ['--model', model, '-p', 'ping']
    const preflight = (dependencies.resolveCommand ?? resolveWindowsCommand)(harness, preflightArgs)
    const preflightEnv = { ...env }
    let preflightHome
    try {
      if (harness === 'grok') {
        preflightHome = mkdtempSync(join(tmpdir(), 'peertable-model-'))
        copyFileSync(join(home, '.grok', 'auth.json'), join(preflightHome, 'auth.json'))
        chmodSync(join(preflightHome, 'auth.json'), 0o600)
        preflightEnv.GROK_HOME = preflightHome
        script('grok-seat-config.mjs', [project, join(preflightHome, 'config.toml')], { env: preflightEnv })
      }
      execute(preflight.command, preflight.argv, { cwd: tmpdir(), env: preflightEnv, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } finally { if (preflightHome) rmSync(preflightHome, { recursive: true, force: true }) }
  }

  // 登録前に中断した席も、公開envで同じroomの本人と確認して撤去する。
  await leave(project, name)
  const credential = script('seat-credential.mjs', ['prepare', project, state.room, name], { env })
  Object.assign(env, {
    PEERTABLE_URL: state.server_url, PEERTABLE_ROOM: state.room, PEERTABLE_MEMBER: name,
    PEERTABLE_CREDENTIAL_FILE: credential, PEERTABLE_HARNESS: harness, PEERTABLE_VENDOR: harness,
    PEERTABLE_MODEL: model, PEERTABLE_EFFORT: effort || '', PEERTABLE_ROLE: placement.roles[0],
    PEERTABLE_ROLES: placement.roles.join(','), PEERTABLE_MISSION: options.mission || '',
  })
  if (state.mode === 'lattice') Object.assign(env, {
    PEERTABLE_PLAN: state.plan_key, LATTICE_CLI: state.lattice_cli || env.LATTICE_CLI || 'lattice',
    LATTICE_TODO_ACTOR_HOST: env.LATTICE_TODO_ACTOR_HOST || hostname(),
    LATTICE_TODO_ACTOR_SESSION: name, LATTICE_TODO_ACTOR_AGENT: name,
  })
  const api = dependencies.api ?? new RoomApi(state, { credential })
  const aiterm = dependencies.aiterm ?? new AitermClient({ env })
  const sessionId = `peer-${name}`
  let launched = false
  let launchPhase = false
  try {
    prepareHarness(project, name, harness, env, script, home)
    const before = await aiterm.sessions()
    if (before.some(session => session.session_id === sessionId)) fail('SEAT_SESSION_CONFLICT', `${sessionId} が既に存在します`)
    beginSeatLaunch(project, name)
    launchPhase = true
    launched = true
    const launch = await aiterm.structured('agent_launch', {
      session_name: sessionId, harness: harnessIds[harness], model, reasoning_effort: effort,
      cwd: project, trust_project: true,
      env_vars: [
        'PEERTABLE_URL', 'PEERTABLE_ROOM', 'PEERTABLE_MEMBER', 'PEERTABLE_CREDENTIAL_FILE',
        'PEERTABLE_HARNESS', 'PEERTABLE_VENDOR', 'PEERTABLE_MODEL', 'PEERTABLE_EFFORT',
        'PEERTABLE_ROLE', 'PEERTABLE_ROLES', 'PEERTABLE_MISSION', 'PEERTABLE_PLAN',
        'LATTICE_CLI', 'LATTICE_TODO_ACTOR_HOST', 'LATTICE_TODO_ACTOR_SESSION', 'LATTICE_TODO_ACTOR_AGENT',
        'GROK_HOME', 'CODEX_HOME',
      ].filter(key => env[key] !== undefined),
    }, 'aiterm.agent-launch-result.v1')
    if (launch.session_id !== sessionId || launch.startup?.status !== 'ready') {
      fail('SEAT_STARTUP_NOT_READY', `${name} の起動準備が完了していません: ${launch.startup?.reason ?? 'startup応答なし'}`)
    }
    const readyDeadline = Date.now() + 90_000
    for (;;) {
      await passSeatApproval(aiterm, sessionId, harness)
      const registered = (await api.members()).find(member => member.name === name)
      if (registered) break
      if (Date.now() >= readyDeadline) fail('SEAT_ROOM_MCP_NOT_READY', `${name} のroom参加登録を確認できません`)
      await delay(1000)
    }
    const observed = await aiterm.observe(sessionId)
    if (!observed.process_identity) fail('SEAT_IDENTITY_UNAVAILABLE', `${name} の本人性を確認できません`)
    await api.request('members', { method: 'POST', body: {
      name, ...observed.process_identity, identity_recorded_at: observed.observed_at,
    } })
    await ensureRuntime(project, { env })
    let turnStarted = false
    if (brief) {
      const receipt = await aiterm.structured('pty_send', { session_id: sessionId, text: brief }, 'aiterm.pty-send-result.v1')
      if (receipt.mode !== 'agent_dispatch' || receipt.submit_residue || receipt.event_cursor == null || !receipt.wait_process) {
        fail('LAUNCH_BRIEF_SEND_FAILED', `${name} の着任指示が成立していません`)
      }
      let completion = null
      const wp = receipt.wait_process
      const waiter = (dependencies.spawn ?? spawn)(wp.executable, wp.args, { detached: true, stdio: 'ignore', env })
      waiter.on('error', error => { completion = { error } })
      waiter.on('exit', code => { completion = { code } })
      waiter.unref()
      const deadline = Date.now() + 60_000
      for (;;) {
        if (completion?.error) throw completion.error
        if (completion && completion.code !== 0) fail('LAUNCH_BRIEF_TURN_FAILED', `完了観測がexit ${completion.code}を返しました`)
        const current = await aiterm.observe(sessionId)
        if (current.state === 'busy' || completion?.code === 0) { turnStarted = true; break }
        await passSeatApproval(aiterm, sessionId, harness)
        if (Date.now() >= deadline) fail('LAUNCH_BRIEF_TURN_NOT_STARTED', `${name} の実ターン開始を確認できません`)
        await delay(1000)
      }
    }
    const stored = (await api.members()).find(member => member.name === name)
    if (!stored?.model || !stored.roles?.length || !stored.aiterm_session_id || !stored.pid) fail('SEAT_LEDGER_INCOMPLETE', `${name} の台帳が不完全です`)
    return { schema: 'peertable.seat-launch.v1', status: 'ready', member: name, session_id: sessionId, placement, turn_started: turnStarted }
  } catch (error) {
    if (launched) {
      try { await leave(project, name, { aiterm, api }) }
      catch (rollback) { throw new AggregateError([error, rollback], `着座失敗後の撤去も失敗しました: ${error.message}; ${rollback.message}`) }
    } else script('seat-credential.mjs', ['remove', project, credential], { env })
    throw error
  } finally {
    if (launchPhase) endSeatLaunch(project, name)
    if (!dependencies.aiterm) await aiterm.close()
  }
}
