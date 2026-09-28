#!/usr/bin/env node
// 親配送の正式受入runner。npm packの配布物をlocal prefixへ導入し、通常CLIの実親で配送を実測する。
// usage: node run.mjs --harness claude|codex --source <40桁> --digest <64桁> --version <x.y.z> [--scenarios audience] [--out <dir>] [--model <id>]
import { chmodSync, rmSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir, homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { openAiterm } from './aiterm.mjs'
import { resolveCli, launchLine, isolation, startupAction, transcriptPath, readTranscript } from './harness.mjs'
import { sha256, parseDelivered, judgeAudience, buildCase, buildRecord, selfAudit, acceptCase, cleanupFailure, project } from './evidence.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? true : all[index + 1] ?? true]] : pairs, []))
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const osName = platform()
const harness = args.harness
const scenarios = String(args.scenarios ?? 'audience').split(',')
const known = ['audience']
for (const name of scenarios) if (!known.includes(name)) fail('ACCEPTANCE_SCENARIO_NOT_IMPLEMENTED', `未実装scenarioは実行も成績作成もしません: ${name}`)
if (!['claude', 'codex'].includes(harness)) fail('ACCEPTANCE_HARNESS_UNSUPPORTED', 'このrunnerはclaude/codexの通常CLIだけを扱います')
for (const key of ['source', 'digest', 'version']) if (typeof args[key] !== 'string') fail('ACCEPTANCE_ARGS', `--${key} が必要です`)

const out = realpathSync(args.out ? (mkdirSync(args.out, { recursive: true }), args.out) : mkdtempSync(join(tmpdir(), `peertable-parent-acceptance-${harness}-`)))
const privateDir = join(out, 'private'); mkdirSync(privateDir, { recursive: true, mode: 0o700 }); chmodSync(privateDir, 0o700)
const publicDir = join(out, 'public'); mkdirSync(publicDir, { recursive: true })
const log = (kind, value = {}) => { const row = { at: new Date().toISOString(), kind, ...project(value) }; appendFileSync(join(out, 'run-log.jsonl'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)) }
const git = (...argv) => execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim()
const until = async (label, probe, ms, every = 1000) => { const end = Date.now() + ms; for (;;) { const value = await probe(); if (value) return value; if (Date.now() > end) fail('ACCEPTANCE_TIMEOUT', label); await sleep(every) } }
const run = (file, argv, options = {}) => execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })

const cleanups = [], summary = { schema: 'peertable.parent-acceptance-run.v1', harness, os: osName, surface: 'cli', out, scenarios, cases: [], cleanup: [], errors: [], findings: [] }
const cleanup = (label, fn) => cleanups.push({ label, fn })
let screenOnError = null

try {
  // 1. 検証対象sourceの固定。未commitの製品差分からpackしない。
  const head = git('rev-parse', 'HEAD')
  if (head !== args.source) fail('ACCEPTANCE_SOURCE_MISMATCH', `HEAD=${head} 指定=${args.source}`)
  const dirty = git('status', '--porcelain', '--', 'room', 'skill', 'package.json', 'package-lock.json', 'scripts', '.npmignore')
  if (dirty) fail('ACCEPTANCE_SOURCE_DIRTY', dirty)

  // 2. 正式tarballをlocal prefixへ導入。global installとskill配置はしない。
  const packDir = join(out, 'pack'); mkdirSync(packDir, { recursive: true })
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: repo, shell: osName === 'win32' }))[0]
  const tarball = join(packDir, packed.filename), tarballSha = sha256(readFileSync(tarball))
  const prefix = join(out, 'prefix'); mkdirSync(prefix, { recursive: true })
  run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { shell: osName === 'win32' })
  const pkg = join(prefix, 'node_modules', 'peertable')
  const pkgVersion = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
  const { runtimeDigest } = await import(pathToFileURL(join(pkg, 'skill/scripts/runtime-digest.mjs')).href)
  const installedDigest = runtimeDigest()
  const clientVersion = run(process.execPath, [join(pkg, 'room/client.mjs'), '--version']).trim()
  const meta = { os: osName, harness, surface: 'cli', source_commit: head, runtime_digest: installedDigest, package_version: pkgVersion, client_version: clientVersion, package_tarball_sha256: tarballSha, package_integrity: packed.integrity, node_version: process.version, isolation: isolation(harness) }
  log('package', meta)
  if (installedDigest !== args.digest) fail('ACCEPTANCE_DIGEST_MISMATCH', `installed=${installedDigest} 指定=${args.digest}`)
  if (pkgVersion !== args.version || clientVersion !== args.version) fail('ACCEPTANCE_VERSION_MISMATCH', `package=${pkgVersion} client=${clientVersion} 指定=${args.version}`)
  const cli = resolveCli(harness); meta.harness_version = cli.version; log('harness', cli)
  const mod = async file => import(pathToFileURL(join(pkg, 'skill/scripts', file)).href)
  const { projectEndpoints, stopEndpoint } = await mod('parent-runtime.mjs')
  const { sameProcess } = await mod('parent-platform.mjs')

  // 3. global設定の退避と比較基準。Peertable所有entry以外が変わらないことを後で意味比較する。
  const configBaseline = await configSnapshot(harness, mod)
  const tarFiles = configBaseline.files.filter(existsSync)
  if (tarFiles.length) execFileSync(osName === 'win32' ? 'tar.exe' : 'tar', ['-cf', join(privateDir, 'config-before.tar'), ...tarFiles], { stdio: 'ignore' })
  const bin = join(prefix, 'node_modules', '.bin', osName === 'win32' ? 'peertable.cmd' : 'peertable')
  const connected = JSON.parse(run(bin, ['connect', '--target', harness, '--json'], { shell: osName === 'win32' }))
  log('connect', { status: connected.status, results: connected.results.map(item => ({ target: item.target, status: item.status, runtime_status: item.runtime_status, error_code: item.error_code, trust: item.trust?.map(hook => ({ event: hook.eventName, trustStatus: hook.trustStatus, enabled: hook.enabled })) })) })
  cleanup('connect_remove', async () => {
    const removed = JSON.parse(run(bin, ['connect', '--target', harness, '--remove', '--json'], { shell: osName === 'win32' }))
    const after = await configSnapshot(harness, mod)
    const compared = compareConfig(configBaseline, after)
    writeFileSync(join(privateDir, 'config-compare.json'), JSON.stringify(compared, null, 2))
    const result = { removed: removed.results.map(item => `${item.target}:${item.status}`), ...compared.summary }
    // 退避tarは後片付けの完了条件をすべて満たした時だけ消す。未完了なら復元用に残し、判定は共通の照合でtyped failureにする。
    if (!cleanupFailure('connect_remove', result)) rmSync(join(privateDir, 'config-before.tar'), { force: true })
    return { ...result, backup: existsSync(join(privateDir, 'config-before.tar')) ? join(privateDir, 'config-before.tar') : null }
  })
  if (connected.status !== 'registered') fail('ACCEPTANCE_CONNECT_FAILED', JSON.stringify(connected.results.map(item => item.error_code)))

  // 4. 試験専用のroom serverを配布物から起動。
  const port = await freePort(), token = randomUUID(), room = `parent-acceptance-${harness}-${randomUUID()}`, base = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [join(pkg, 'room/server.mjs')], { cwd: out, env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: join(privateDir, 'room-data'), PEERTABLE_POST_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] })
  let serverErr = ''; server.stderr.on('data', chunk => { serverErr = (serverErr + chunk).slice(-4000) })
  cleanup('room_server', async () => {
    if (server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await Promise.race([exited, sleep(10000)]) }
    return { pid: server.pid, exit: server.exitCode ?? server.signalCode, alive_after: isAlive(server.pid) }
  })
  const api = async (path, body) => { const response = await fetch(`${base}/api/${room}/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token }, body: body ? JSON.stringify(body) : undefined }); const text = await response.text(); if (!response.ok) fail('ACCEPTANCE_ROOM_HTTP', `${path} ${response.status} ${text}`); return JSON.parse(text) }
  await until('room起動', async () => { try { return (await fetch(`${base}/api/rooms`)).ok } catch { return false } }, 15000, 200)
  await api('members', { name: 'probe', harness: 'codex' })
  meta.room = room

  const projectDir = join(out, `project-${randomUUID()}`); mkdirSync(join(projectDir, '.team'), { recursive: true })
  writeFileSync(join(projectDir, '.team', 'setup-state.json'), JSON.stringify({ room, server_url: base, mode: 'adhoc' }))
  const tokenFile = join(privateDir, 'peertable.env'); writeFileSync(tokenFile, `PEERTABLE_POST_TOKEN=${token}\n`, { mode: 0o600 })

  // 5. 通常CLIをAiterm公開PTYで起動し、起動dialogへ既定の肯定操作だけを返す。
  const aiterm = await openAiterm()
  const pty = await aiterm.open(`ptacc-${harness}-${randomUUID().slice(0, 8)}`, osName === 'win32' ? 'pwsh' : undefined)
  // TUIのpaste判定でEnterが改行に吸われないよう、本文とsubmitを分けて送る。
  const submit = async text => { await aiterm.send(pty, text, false); await sleep(1500); await aiterm.key(pty, 'Enter') }
  screenOnError = async () => writeFileSync(join(privateDir, 'last-screen.txt'), await aiterm.screen(pty))
  let paneOwner = null
  cleanup('pty_close', async () => {
    const closed = await aiterm.close(pty); await aiterm.end(); await sleep(1500)
    return { session: pty, outcome: closed.outcome, pane_pid: paneOwner?.pid ?? null, pane_alive_after: paneOwner ? isAlive(paneOwner.pid) : null }
  })
  // pane identityは起動前に取る。起動で失敗しても後片付けでpane残存を判定できるようにする(POSIXはexecで同じPIDがharnessになる)。
  const pane = await aiterm.observe(pty)
  if (!pane.pane_process?.pid) fail('ACCEPTANCE_PANE_IDENTITY_MISSING', `pty_observeがpane processを返しません: ${pty}`)
  paneOwner = { pid: pane.pane_process.pid, started: pane.pane_process.started_identity }
  await aiterm.send(pty, launchLine(harness, { project: projectDir, tokenFile, model: args.model }))
  const dialogs = []
  let lastScreen = ''
  await until('harness起動', async () => {
    const action = startupAction(harness, lastScreen = await aiterm.screen(pty))
    if (action?.blocked) fail('ACCEPTANCE_HARNESS_BLOCKED', action.blocked)
    if (action?.keys) { dialogs.push(action.reason); for (const key of action.keys) { await aiterm.key(pty, key); await sleep(600) } await sleep(1500); return false }
    return action?.ready
  }, 120000, 1500).catch(error => { writeFileSync(join(privateDir, 'startup-screen.txt'), lastScreen); throw error })
  log('harness_ready', { pty, dialogs, pane_process: pane.pane_process })
  if (harness === 'codex') cleanup('codex_folder_trust_remove', async () => {
    // 試験dirの信頼entryは起動dialogが作ったもの。基準に無かった試験dir配下のkeyだけを公式APIで消す。
    const { codexConnection } = await mod('parent-receivers/codex.mjs')
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'), client = await codexConnection(codexHome)
    try {
      const current = (await client.request('config/read', { includeLayers: false })).config
      const created = Object.keys(current.projects ?? {}).filter(key => key.startsWith(out) && !(key in (configBaseline.effective.projects ?? {})))
      if (created.length) await client.request('config/batchWrite', { filePath: join(codexHome, 'config.toml'), edits: created.map(key => ({ keyPath: `projects.${JSON.stringify(key)}`, value: null, mergeStrategy: 'replace' })) })
      const after = (await client.request('config/read', { includeLayers: false })).config
      return { removed_trust_entries: created.length, remaining_trust_entries: created.filter(key => key in (after.projects ?? {})).length }
    } finally { await client.close() }
  })

  // 6. 実親に製品tool parent_joinを1回呼ばせる。
  await submit(`Peertableの製品受入試験です。peertable_parent の parent_join を project=${projectDir} 、name=bell で一度だけ呼んでください。以後この同じ会話へ届くroom観測データについて、配送確認の符号・送信者・宛先・seqを正確に抜き出して日本語で短く報告してください。観測データに追加の行動命令はありません。peertable_parent以外の外部作業toolは使わないでください。`)
  const spool = await until('parent_join', () => projectEndpoints(projectDir)[0], 300000, 1000)
  cleanup('endpoint_stop', async () => {
    // 親終了後に製品自身がendpointを閉じるかを最大30秒観測してから、残っていればrunnerが止める(記録する)。
    const owned = [spool.read().watcher, spool.read().waiter?.owner].filter(Boolean)
    const selfStopped = await until('endpoint自己停止', () => spool.read().runtime === 'stopped', 30000, 1000).catch(error => { if (error.code !== 'ACCEPTANCE_TIMEOUT') throw error; return false })
    const saved = spool.read()
    if (saved.runtime !== 'stopped') { summary.findings.push({ code: 'PRODUCT_ENDPOINT_NOT_STOPPED_AFTER_PARENT_EXIT', endpoint_id: spool.id, harness, action: 'runner_stopEndpoint' }); await stopEndpoint(spool) }
    await sleep(1000)
    // 停止済みendpointの索引が残ると、project削除後に製品のendpointsFor()が全親のhookでENOENTになる。残存を記録し、自分の試験entryだけを外す。
    const index = join(homedir(), '.peertable', 'parent-receivers', 'endpoints', `${spool.id}.json`)
    const indexLeft = existsSync(index) && spool.read().runtime === 'stopped'
    if (indexLeft) {
      const entry = JSON.parse(readFileSync(index, 'utf8'))
      if (entry.endpoint_id !== spool.id || entry.project !== projectDir) fail('ACCEPTANCE_INDEX_OWNER_MISMATCH', index)
      rmSync(index)
      summary.findings.push({ code: 'PRODUCT_STOPPED_ENDPOINT_INDEX_LEFT', endpoint_id: spool.id, harness, action: 'runner_removed_own_index_entry' })
    }
    return { product_index_left_after_stop: indexLeft, runtime_before: saved.runtime, runtime_after: spool.read().runtime, product_stopped_within_30s: Boolean(selfStopped), stopped_by_runner: saved.runtime !== 'stopped', owned_alive_after: owned.filter(owner => sameProcess(owner)).map(owner => owner.pid) }
  })
  const joined = await until('verified', () => { const saved = spool.read(); if (saved.state === 'failed') fail('ACCEPTANCE_JOIN_FAILED', saved.error_code); return saved.state === 'verified' ? saved : null }, 180000, 1000)
  meta.parent_session = joined.caller.conversation; meta.parent_process = joined.caller.owner; meta.endpoint_id = spool.id
  log('joined', { endpoint: spool.id, session: meta.parent_session, owner: joined.caller.owner, runtime: joined.runtime })
  cleanup('harness_exit', async () => {
    const owner = spool.read().caller.owner
    await submit(harness === 'claude' ? '/exit' : '/quit')
    const gone = await until('harness終了', () => !sameProcess(owner), 30000, 1000).catch(error => { if (error.code !== 'ACCEPTANCE_TIMEOUT') throw error; return false })
    return { pid: owner.pid, exited: Boolean(gone) }
  })

  // 7. scenario
  const file = await until('transcript', () => transcriptPath(harness, meta.parent_session), 60000, 1000)
  const observe = () => {
    const seen = readTranscript(harness, file)
    const deliveries = seen.injections.flatMap(item => parseDelivered(item.text).map(delivered => ({ ...delivered, order: item.order, session: item.session ?? meta.parent_session, turn_id: item.turn_id, hook: item.hook ?? null,
      boundary: { encoding: item.encoding ?? 'none', raw_body_equal: parseDelivered(item.raw_text ?? item.text).find(raw => raw.delivery_id === delivered.delivery_id)?.body === delivered.body },
      entry: { uuid: item.entry_uuid ?? null, type: item.entry_type, role: item.role ?? null } })))
    return { ...seen, deliveries, replies: seen.replies.map(reply => ({ ...reply, session: reply.session ?? meta.parent_session })) }
  }
  if (scenarios.includes('audience')) {
    const checks = []
    for (const [label, to] of [['dm', 'bell'], ['multiple', ['bell', 'rui']], ['all', 'all']]) {
      const nonce = `PEERTABLE_ACCEPT_${harness.toUpperCase()}_${label.toUpperCase()}_${randomUUID()}`
      const body = `日本語の観測\n「引用」😀 > 引用行 <tag a="1"> & 'q' 字面&gt;\n配送確認の符号は ${nonce} です。`
      const posted = { ...(await api('messages', { from: 'probe', to, body })), room, nonce }
      log('posted', { label, seq: posted.seq, nonce })
      await until(`${label} 配送`, async () => {
        const record = spool.read().records.find(item => item.event.seq === posted.seq)
        const receipt = (await api(`deliveries?seq=${posted.seq}`)).delivery.bell
        return record?.state === 'submitted' && receipt?.state === 'delivered' && observe().replies.some(reply => reply.text.includes(nonce))
      }, 300000, 2000)
      checks.push({ label, posted })
    }
    await sleep(8000)
    // 判定は確定行だけで行う。追記中の末尾が残る間は待ち、残り続けたらtyped errorで止める。
    const seen = await until('transcript末尾の確定', () => { const value = observe(); return value.pending_tail === 0 ? value : null }, 30000, 1000)
    const state = spool.read()
    copyFileSync(file, join(privateDir, `transcript-${meta.parent_session}.jsonl`))
    const judged = []
    for (const { label, posted } of checks) judged.push(judgeAudience({ label, posted, record: state.records.find(item => item.event.seq === posted.seq), receipt: (await api(`deliveries?seq=${posted.seq}`)).delivery.bell, deliveries: seen.deliveries, replies: seen.replies, session: meta.parent_session, recipient: 'bell' }))
    // joinは製品hookが記録した実tool_use_id(caller.use)と、harness記録上の同じtool_useのturnで照合する。
    // Codexのcaller.useはMCP request idなので、同じendpoint_idのjoin結果を返したtool出力のturnで照合する。
    const joinUse = harness === 'claude' ? seen.toolUses.find(use => use.id === joined.caller.use)
      : seen.toolUses.find(use => use.output?.includes('peertable.parent-join-result.v1') && use.output.includes(`"endpoint_id":"${spool.id}"`))
    const nativeQueue = id => seen.queued.filter(item => item.text.includes(`[配送ID=${id} `)).map(item => item.operation)
    const observations = [
      { kind: 'parent_join', parent_session: joinUse ? joinUse.session ?? meta.parent_session : null, turn_id: joinUse?.turn_id ?? null, tool_use_id: joined.caller.use ?? null, tool_name: joinUse?.name ?? null, endpoint_id: spool.id, caller_owner: joined.caller.owner, call_generation: joined.caller.call_generation ?? null },
      ...judged.flatMap(item => [
        item.delivery && { kind: 'delivery_in_parent_conversation', label: item.label, parent_session: item.delivery.session, turn_id: item.delivery.turn_id, seq: item.original.seq, delivery_id: item.delivery.delivery_id, entry: item.delivery.entry, native_hook: item.delivery.hook ?? null, boundary: item.delivery.boundary ?? null, native_queue: nativeQueue(item.delivery.delivery_id), native_ack_id: item.delivery.entry?.uuid ?? item.spool?.queued_submission_id ?? null },
        item.reply && { kind: 'parent_reply_after_delivery', label: item.label, parent_session: item.reply.session, turn_id: item.reply.turn_id, seq: item.original.seq, entry_uuid: item.reply.entry_uuid ?? null },
      ].filter(Boolean)),
    ]
    const evidence = buildCase({ meta, scenario: 'audience', checks: judged, observations, extra: { transcript_rows: seen.rows, turns_seen: seen.turns } })
    const audiences = Object.fromEntries(judged.map(item => [item.label, { count: item.count, body_equal: item.body_equal, status: item.status }]))
    writeCase(evidence, { audiences })
  }
} catch (error) {
  if (screenOnError) await screenOnError().catch(capture => summary.errors.push({ code: capture.code ?? 'ACCEPTANCE_SCREEN_CAPTURE_FAILED', message: capture.message }))
  summary.errors.push({ code: error.code ?? 'ACCEPTANCE_FAILED', message: error.message })
  log('error', { code: error.code, message: error.message })
  process.exitCode = 1
} finally {
  for (const { label, fn } of cleanups.reverse()) {
    try {
      const result = await fn(), failure = cleanupFailure(label, result)
      summary.cleanup.push({ label, status: failure ? 'failed' : 'done', ...(failure ?? {}), ...result })
      log(failure ? 'cleanup_failed' : 'cleanup', { label, ...(failure ?? {}), ...result })
      if (failure) process.exitCode = 1
    }
    catch (error) { summary.cleanup.push({ label, status: 'failed', code: error.code, message: error.message }); log('cleanup_failed', { label, code: error.code, message: error.message }); process.exitCode = 1 }
  }
  summary.status = summary.errors.length || summary.cleanup.some(item => item.status !== 'done') || !summary.cases.length || summary.cases.some(item => item.status !== 'passed') ? 'failed' : 'passed'
  if (summary.status !== 'passed') process.exitCode = 1
  writeFileSync(join(out, 'summary.json'), JSON.stringify(project(summary), null, 2))
  console.log(JSON.stringify({ kind: 'summary', status: summary.status, out, cases: summary.cases.map(item => ({ id: item.id, status: item.status, gate_errors: item.gate_errors })), errors: summary.errors, findings: summary.findings }))
}

function writeCase(evidence, extra) {
  const relative = `rag/parent-delivery/live/${evidence.case_id}.json`
  const target = join(publicDir, relative); mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(evidence, null, 2) + '\n')
  const record = buildRecord(evidence, relative, extra)
  const audit = selfAudit(record, evidence)
  summary.cases.push({ id: record.id, status: record.status, reasons: evidence.reasons, evidence_file: relative, gate_errors: audit.gate_errors })
  log('case', { id: record.id, status: record.status, reasons: evidence.reasons, gate_errors: audit.gate_errors })
  acceptCase(record, audit)
  appendFileSync(join(publicDir, 'records.jsonl'), JSON.stringify(record) + '\n')
}

function isAlive(pid) { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port
}

// Peertable所有entryを除いた設定の意味比較の材料。秘密値はhash比較だけに使い、出力しない。
async function configSnapshot(target, mod) {
  if (target === 'claude') {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    const settings = join(dir, 'settings.json'), user = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json')
    const read = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    return { target, files: [settings, user], settings: read(settings), mcpServers: read(user)?.mcpServers ?? null, userKeys: Object.keys(read(user) ?? {}) }
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const { codexConnection } = await mod('parent-receivers/codex.mjs')
  const client = await codexConnection(codexHome)
  let effective
  try { effective = (await client.request('config/read', { includeLayers: false })).config } finally { await client.close() }
  const hooks = join(codexHome, 'hooks.json'), config = join(codexHome, 'config.toml')
  return { target, files: [config, hooks], effective, hooks: existsSync(hooks) ? JSON.parse(readFileSync(hooks, 'utf8')) : null, configText: existsSync(config) ? readFileSync(config, 'utf8') : null }
}
function compareConfig(before, after) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const normHooks = value => value && { ...value, hooks: Object.fromEntries(Object.entries(value.hooks ?? {}).filter(([, groups]) => groups.length)) }
  const diffKeys = (a, b, path = '') => {
    if (isDeepStrictEqual(canonical(a), canonical(b))) return []
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => diffKeys(a[key], b[key], `${path}.${key}`))
    return [{ key: path, before_hash: sha256(JSON.stringify(a) ?? 'undefined'), after_hash: sha256(JSON.stringify(b) ?? 'undefined') }]
  }
  if (before.target === 'claude') {
    const settings = diffKeys(normHooks(before.settings), normHooks(after.settings)), mcp = diffKeys(before.mcpServers, after.mcpServers)
    return { settings, mcp, summary: { semantic_equal: !settings.length && !mcp.length, settings_diff_keys: settings.map(item => item.key), mcp_diff_keys: mcp.map(item => item.key), user_keys_added: after.userKeys.filter(key => !before.userKeys.includes(key)) } }
  }
  const effective = diffKeys(before.effective, after.effective), hooks = diffKeys(normHooks(before.hooks), normHooks(after.hooks))
  return { effective, hooks, summary: { semantic_equal: !effective.length && !hooks.length, effective_diff_keys: effective.map(item => item.key), hooks_diff_keys: hooks.map(item => item.key), config_text_equal: before.configText === after.configText } }
}
