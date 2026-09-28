// Cursor/Grok公式CLIの起動と試験project設定。会話/taskの観測はbackground-harness.mjsへ接続する。
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
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
      const hookFile = join(fixture.directory, 'product-hook-events.jsonl'), observers = new Map()
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
          if (harness === 'grok' && /Grok 4|grok.*build/iu.test(screen) && /❯|›|>\s*$/mu.test(screen)) return { ready: true }
          return null
        },
        nativeTaskOutputPath: id => harness === 'cursor' ? join(homedir(), '.cursor/projects', fixture.project.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+/u, ''), 'terminals', `${id}.txt`) : null,
        transcript: session => { const file = transcriptPath(session); return existsSync(file) ? file : null },
        read: (file, { session }) => observeSession(session),
        taskController: {
          timeoutWindowMs: 86520000,
          async read(id, { session }) {
            const records = observeSession(session).tasks.filter(task => String(task.task_id ?? task.id) === String(id))
            const read = records.find(task => task.reader_tool_use_id && task.result?.schema === 'peertable.parent-background-result.v1')
            if (!read) return { id: String(id), session, finished: false, outcome: null }
            const completed = records.find(task => task.raw_output?.completed === true)
            if (harness === 'grok' && !completed) fail('ACCEPTANCE_GROK_NATIVE_TASK_END_MISSING', '実taskの完了snapshotがありません')
            const result = read.result
            return { id: String(id), session, finished: true, outcome: result.outcome === 'timeout' && result.error_code === 'PARENT_RECEIVER_EXPIRED' ? 'timeout' : result.outcome, output: result, artifact: read.output_file, exit_code: completed?.raw_output?.exit_code ?? null, delivered: result.outcome === 'ready', reader_tool_use_id: read.reader_tool_use_id }
          },
          async request(operation, { id, session }) {
            if (operation === 'timeout') return { operation: '通常製品leaseの実期限まで待機', id: String(id), session, timeout_shortened: false }
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
        hookEvents: () => existsSync(hookFile) ? readFileSync(hookFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
        hookFile,
      }
    },
  }
  return adapters
}
