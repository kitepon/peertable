// Cursor/Grok公式CLIの起動と試験project設定。会話/taskの観測はbackground-harness.mjsへ接続する。
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
// hook専用の確定行だけを読む。harnessの起動adapterへ逆依存せず、未確定末尾を保留する。
const readOwnHookEvents = file => {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n'); lines.pop()
  return lines.map((line, index) => { try { return JSON.parse(line) } catch { fail('ACCEPTANCE_HOOK_EVENT_CORRUPT', `${file}:${index + 1}の確定hook行がJSONではありません`) } })
}

// WindowsはPowerShell 7へargvを渡す。Nodeの既定shellを選ばず、対話stdinは呼出し元のstdioを継承する。
export function nativeInvocation(executable, args, { platformName = process.platform, shellCommand, interactive = false } = {}) {
  if (platformName !== 'win32') return { executable, argv: args }
  const script = `$ErrorActionPreference='Stop'; ${shellCommand(executable, args, 'win32')}; exit $LASTEXITCODE`
  return { executable: 'pwsh.exe', argv: ['-NoLogo', '-NoProfile', ...(interactive ? [] : ['-NonInteractive']), '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
}

export function resolveOfficialCli(harness, platform) {
  const name = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent', grok: 'grok' }[harness]
  if (!name) fail('ACCEPTANCE_OFFICIAL_CLI_UNSUPPORTED', harness)
  // CLIの公式shimもPowerShellからそのまま呼ぶ。内部native pathを推測しない。
  const executable = process.platform === 'win32' ? execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; (Get-Command ${platform.psQuote(name)} -ErrorAction Stop).Source`, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim() : platform.resolveExecutable(name)
  const invocation = nativeInvocation(executable, ['--version'], { shellCommand: platform.shellCommand })
  const version = execFileSync(invocation.executable, invocation.argv, { encoding: 'utf8' }).trim().split(/\r?\n/u)[0]
  return { executable, version }
}

// Grokの公式task snapshotと完成済みreader入力を照合する。終了説明の自由文は判定に使わない。
export function grokControlledTaskEnd(seen, request, { sameProcess }) {
  const { id, session, before, operation } = request
  const task = seen.tasks.find(item => item.type === 'task_completed' && String(item.task_id) === String(id) && item.order >= before)
  if (!task) return null
  const snapshot = task.raw_output
  if (task.session !== session || snapshot.owner_session_id !== session || snapshot.task_id !== id || snapshot.completed !== true) fail('ACCEPTANCE_GROK_NATIVE_TASK_OWNER', '対象会話の実task完了ではありません')
  const reader = seen.toolUses.find(use => use.name === 'get_command_or_subagent_output' && use.session === session && use.order > task.order && isDeepStrictEqual(use.input, { task_ids: [id] }) && use.output?.type === 'TaskOutput' && use.output.Result?.task_id === id)
  if (!reader) return null
  const result = reader.output.Result
  if (result.status !== 'completed' || result.truncated !== false || result.output !== snapshot.output || result.output_file !== snapshot.output_file || result.raw_output_bytes !== snapshot.output_total_bytes || Buffer.byteLength(result.output, 'utf8') !== snapshot.output_total_bytes) fail('ACCEPTANCE_GROK_NATIVE_FULL_READ', '実task snapshotと公式全量readerが一致しません')
  let control = null
  if (operation === 'cancel') {
    control = seen.toolUses.find(use => use.name === 'kill_task' && use.session === session && use.order >= before && use.order < task.order && isDeepStrictEqual(use.input, { task_id: id }) && use.output && use.output_order > use.order)
    if (!control || snapshot.explicitly_killed !== true) fail('ACCEPTANCE_GROK_CANCEL_NOT_OBSERVED', '完成済みkill_taskと対象taskの明示終了を確認できません')
  } else if (operation === 'exit') {
    if (snapshot.explicitly_killed !== false || !request.receiver_owner || sameProcess(request.receiver_owner) || snapshot.signal == null && (!Number.isInteger(snapshot.exit_code) || snapshot.exit_code === 0)) fail('ACCEPTANCE_GROK_EXIT_NOT_OBSERVED', '専用受信process消失と非cancelの実task異常終了を確認できません')
    control = request.process_fault
  } else fail('ACCEPTANCE_NATIVE_TASK_CONTROL_UNCONFIRMED', `Grok/${operation}`)
  const products = result.output.split('\n').filter(line => line.startsWith('{')).flatMap(line => { try { const value = JSON.parse(line); return value.schema === 'peertable.parent-background-result.v1' ? [value] : [] } catch { return [] } })
  return { id, session, finished: true, outcome: operation, delivered: products.some(value => value.outcome === 'ready'), output: result.output, artifact: result.output_file, exit_code: snapshot.exit_code, signal: snapshot.signal, task_snapshot: snapshot, control, reader_tool_use_id: reader.id, official_reader: reader }
}

// 背景制御通知も同taskの公式全量readerから取得する。任意Readや別会話の出力は採用しない。
export function assertNativeTaskRead({ harness, id, session, endpointId, project, read, completed, toolUses }) {
  const result = read.result, reader = toolUses.find(use => use.id === read.reader_tool_use_id && use.session === session)
  if (read.session !== session || result.endpoint_id !== endpointId || !reader) fail('ACCEPTANCE_NATIVE_TASK_RESULT_OWNER', '同task/CID/endpointの公式readerではありません')
  if (harness === 'cursor') {
    const path = join(homedir(), '.cursor/projects', project.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+/u, ''), 'terminals', `${id}.txt`)
    if (reader.name !== 'Read' || !isDeepStrictEqual(reader.input, { path }) || read.output_file !== path || !Buffer.isBuffer(read.raw_bytes)) fail('ACCEPTANCE_CURSOR_NATIVE_FULL_READ', 'Cursor公式taskファイルの全量Readではありません')
  } else {
    const snapshot = completed.raw_output, output = read.raw_output
    if (snapshot.owner_session_id !== session || reader.name !== 'get_command_or_subagent_output' || !isDeepStrictEqual(reader.input, { task_ids: [String(id)] }) || reader.order <= completed.order || output.status !== 'completed' || output.truncated !== false || output.output !== snapshot.output || output.output_file !== snapshot.output_file || output.raw_output_bytes !== snapshot.output_total_bytes || Buffer.byteLength(output.output, 'utf8') !== snapshot.output_total_bytes) fail('ACCEPTANCE_GROK_NATIVE_FULL_READ', 'Grok同会話/taskの完了snapshotと全量readerが一致しません')
  }
  return reader
}

export async function createBackgroundSurfaceAdapters({ pkg, tokenFile, backgroundObserverFactory }) {
  if (!backgroundObserverFactory) {
    try { backgroundObserverFactory = (await import('./background-harness.mjs')).createBackgroundHarnessObserver }
    catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; fail('ACCEPTANCE_BACKGROUND_OBSERVER_MISSING', '正式background-harness observerが必要です') }
  }
  const { hookEntries, parentRegistration } = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-connect.mjs')).href)
  const platform = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-platform.mjs')).href)
  const resolve = harness => resolveOfficialCli(harness, platform)
  const adapters = {}
  for (const harness of ['cursor', 'grok']) adapters[harness] = {
    bind(fixture) {
      const hookFile = join(fixture.directory, 'product-hook-events.jsonl'), observers = new Map(), taskRequests = new Map()
      const transcriptPath = session => harness === 'cursor' ? join(homedir(), '.cursor/projects', fixture.project.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+/u, ''), 'agent-transcripts', session, `${session}.jsonl`) : join(homedir(), '.grok/sessions', encodeURIComponent(fixture.project), session, 'updates.jsonl')
      const observeSession = session => {
        const file = transcriptPath(session)
        if (!observers.has(session)) observers.set(session, backgroundObserverFactory({ harness, transcriptPath: file, hookPaths: [hookFile], expectedConversationId: session }))
        return observers.get(session).observe()
      }
      return {
        resolveCli: () => resolve(harness),
        projectHookFile: project => harness === 'cursor' ? join(project, '.cursor/hooks.json') : join(project, '.grok/hooks/acceptance.json'),
        argv: () => harness === 'cursor' ? ['--force', '--approve-mcps', '--trust'] : ['--always-approve'],
        resumeArgs: session => ['--resume', session],
        // 終了command未確認のharnessはown PTY closeを使う。未知のslash commandを送らない。
        exit: null,
        startup(screen) {
          if (/authentication required|Sign in to Cursor|not logged in/iu.test(screen)) return { blocked: 'official_auth_required' }
          if (harness === 'cursor' && /Add a follow-up|Cursor Agent/u.test(screen) && /Run Everything/u.test(screen)) return { ready: true }
          if (harness === 'grok' && /trust.*(?:folder|directory)|(?:folder|directory).*trust/iu.test(screen) && /\by\b|Yes/u.test(screen)) return { keys: ['y', 'Enter'], reason: 'own_grok_project_trust' }
          if (harness === 'grok' && /Grok 4|grok.*build/iu.test(screen) && (/❯|›|>\s*$/mu.test(screen) || /^[ \t]*│ >[ \t]*│[ \t]*$/mu.test(screen))) return { ready: true }
          return null
        },
        nativeTaskOutputPath: id => harness === 'cursor' ? join(homedir(), '.cursor/projects', fixture.project.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+/u, ''), 'terminals', `${id}.txt`) : null,
        transcript: session => { const file = transcriptPath(session); return existsSync(file) ? file : null },
        read: (file, { session }) => observeSession(session),
        taskController: {
          timeoutWindowMs: 86520000,
          async read(id, { session }) {
            const seen = observeSession(session), controlled = taskRequests.get(String(id))
            if (harness === 'grok' && controlled && controlled.operation !== 'timeout') return grokControlledTaskEnd(seen, controlled, { sameProcess: platform.sameProcess }) ?? { id: String(id), session, finished: false, outcome: null }
            const records = seen.tasks.filter(task => String(task.task_id ?? task.id) === String(id))
            const read = records.find(task => task.reader_tool_use_id && task.result?.schema === 'peertable.parent-background-result.v1')
            if (!read) return { id: String(id), session, finished: false, outcome: null }
            const completed = records.find(task => task.raw_output?.completed === true)
            if (harness === 'grok' && !completed) fail('ACCEPTANCE_GROK_NATIVE_TASK_END_MISSING', '実taskの完了snapshotがありません')
            const result = read.result
            const reader = assertNativeTaskRead({ harness, id, session, endpointId: fixture.target.spool.id, project: fixture.project, read, completed, toolUses: seen.toolUses })
            return { id: String(id), session, finished: true, outcome: result.outcome === 'timeout' && result.error_code === 'PARENT_RECEIVER_EXPIRED' ? 'timeout' : result.outcome, output: result, artifact: read.output_file, exit_code: completed?.raw_output?.exit_code ?? null, delivered: result.outcome === 'ready', reader_tool_use_id: read.reader_tool_use_id, official_reader: reader, native_task_completion: completed?.raw_output ?? null, native_read_bytes_sha256: harness === 'cursor' ? createHash('sha256').update(read.raw_bytes).digest('hex') : createHash('sha256').update(read.raw_output.output, 'utf8').digest('hex') }
          },
          async request(operation, { id, session }) {
            if (operation === 'timeout') return { operation: '通常製品leaseの実期限まで待機', id: String(id), session, timeout_shortened: false }
            if (harness === 'grok' && ['cancel', 'exit'].includes(operation)) {
              const target = fixture.target, current = target.spool.read(), parent = target.meta.parent_process, waiter = current.waiter, task = waiter?.native_task
              const identity = (a, b) => a && b && a.pid === b.pid && a.started === b.started
              if (target.spool.project !== fixture.project || current.endpoint_id !== target.spool.id || current.caller.conversation !== session || !identity(current.caller.owner, parent) || !platform.sameProcess(parent) || task?.id !== id || !platform.sameProcess(task.process_identity) || !platform.sameProcess(waiter.owner) || !platform.processDescendsFrom(waiter.owner, task.process_identity)) fail('ACCEPTANCE_NATIVE_TASK_OWNER', '専用fixtureの公式task/受信process相関がありません')
              const request = { operation, id, session, before: observeSession(session).rows }
              taskRequests.set(String(id), request)
              if (operation === 'cancel') await fixture.submit(`専用背景taskの取消を実測します。kill_taskへ完成済み入力${JSON.stringify({ task_id: id })}を渡し、完了後get_command_or_subagent_outputへ完成済み入力${JSON.stringify({ task_ids: [id] })}を渡して全量を読み、終了結果を報告してください。timeout_msを追加せず、他のtaskを操作せず、parent_joinはまだ呼ばないでください。`)
              else {
                const { endpointsFor } = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-caller.mjs')).href)
                if (endpointsFor().some(endpoint => endpoint.id !== target.spool.id && endpoint.read().runtime !== 'stopped' && identity(endpoint.read().waiter?.owner, waiter.owner))) fail('ACCEPTANCE_PROCESS_FAULT_SHARED', '他endpoint共有の受信processを終了しません')
                request.receiver_owner = waiter.owner
                request.process_fault = { operation: 'own受信processへのSIGTERM', owner: waiter.owner, endpoint_id: target.spool.id, parent_session: session, at: new Date().toISOString() }
                process.kill(waiter.owner.pid, 'SIGTERM')
                await fixture.submit(`専用背景task ${id} の終了を実測します。task_completed後にget_command_or_subagent_outputへ完成済み入力${JSON.stringify({ task_ids: [id] })}を渡して全量を読み、終了結果を報告してください。timeout_msを追加せず、taskをkillせず、parent_joinはまだ呼ばないでください。`)
              }
              return request
            }
            fail('ACCEPTANCE_NATIVE_TASK_CONTROL_UNCONFIRMED', `${harness}/${operation}: 公式cancel/exit操作は未実測です`)
          },
        },
        afterStartup: harness === 'grok' ? () => fixture.submit('/hooks-trust') : null,
        async prepare() {
          // 新規fixtureのproject設定のみ。通常HOMEのhook/MCP/provider/authには触れない。
          execFileSync('git', ['init', '--quiet', fixture.project])
          const tee = join(fixture.project, 'product-hook-tee.mjs')
          writeFileSync(tee, `import {spawnSync} from 'node:child_process';import {appendFileSync} from 'node:fs';const chunks=[];for await(const c of process.stdin)chunks.push(c);const raw=Buffer.concat(chunks),result=spawnSync(process.execPath,[process.argv[3],process.argv[4]],{input:raw});const event=JSON.parse(raw.toString('utf8').replace(/^\\uFEFF/u,''));delete event.user_email;appendFileSync(process.argv[2],JSON.stringify({at:new Date().toISOString(),pid:process.pid,stdin_prefix_hex:raw.subarray(0,4).toString('hex'),event,stdout:result.stdout.toString('utf8'),stderr:result.stderr.toString('utf8'),code:result.status})+'\\n');process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;\n`, { mode: 0o600 })
          const command = platform.hookCommand(process.execPath, [tee, hookFile, join(pkg, 'skill/scripts/parent-hook.mjs'), harness])
          const rewrite = value => Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'command' ? command : rewrite(child)])) : value
          const owned = rewrite(hookEntries(harness)), registration = { ...parentRegistration(), env: { PEERTABLE_TOKEN_SOURCE_FILE: tokenFile } }
          if (harness === 'cursor') {
            fixture.modify(join(fixture.project, '.cursor/mcp.json'), () => Buffer.from(JSON.stringify({ mcpServers: { peertable_parent: registration } }) + '\n'))
            fixture.modify(join(fixture.project, '.cursor/hooks.json'), () => Buffer.from(JSON.stringify({ version: 1, hooks: owned }) + '\n'))
          } else {
            fixture.modify(join(fixture.project, '.grok/config.toml'), () => Buffer.from(`[mcp_servers.peertable_parent]\ncommand = ${JSON.stringify(registration.command)}\nargs = ${JSON.stringify(registration.args)}\n[mcp_servers.peertable_parent.env]\nPEERTABLE_TOKEN_SOURCE_FILE = ${JSON.stringify(tokenFile)}\n`))
            fixture.modify(join(fixture.project, '.grok/hooks/peertable-parent.json'), () => Buffer.from(JSON.stringify({ hooks: owned }) + '\n'))
          }
        },
        hookEvents: () => readOwnHookEvents(hookFile),
        hookFile,
      }
    },
  }
  return adapters
}
