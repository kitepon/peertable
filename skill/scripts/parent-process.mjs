// 親のwatcherを、親harnessのプロセス終了処理(Job Object等)の外で起動する。
// OS差は起動APIへの適合だけに置く。起動後のlog・stdin・env・cwd・終了の契約は全OS共通。
import { spawn, spawnSync } from 'node:child_process'
import { openSync, closeSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failure, readJson, atomicJson, windowsArgumentList } from './parent-platform.mjs'

const self = fileURLToPath(import.meta.url)
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// CodexはMCP serverをJob Objectへ入れ、/quitでJobごと終了させる。Nodeのspawnは子をJobへ残すため、
// WMI Win32_Process.CreateでJob外にbootstrapを起動し、bootstrapがwatcherをdetached起動する。
// envはargvへ載せず、pwsh 7のstdinからWin32_ProcessStartup.EnvironmentVariablesへ渡す。
const wmiCreate = `
$ErrorActionPreference = 'Stop'
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
$spec = $reader.ReadToEnd() | ConvertFrom-Json
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]0x400; EnvironmentVariables = [string[]]@($spec.env) }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $spec.commandLine; CurrentDirectory = $spec.cwd; ProcessStartupInformation = $startup }
@{ return_value = [int]$result.ReturnValue; pid = [int]$result.ProcessId } | ConvertTo-Json -Compress
`

const startFailed = detail => failure('PARENT_WATCH_START_FAILED', detail)
const validPid = value => Number.isSafeInteger(value) && value > 0
// 外部(pwsh/WMI)の応答境界。壊れた応答・欠けた項目・非0の戻り値は起動失敗として明示する。
export function parseWmiResult(stdout) {
  let created
  try { created = JSON.parse(stdout) } catch { throw startFailed(`WMIの応答がJSONではありません: ${String(stdout).slice(0, 200)}`) }
  if (!Number.isSafeInteger(created?.return_value)) throw startFailed(`WMIの応答にreturn_valueがありません: ${String(stdout).slice(0, 200)}`)
  if (created.return_value !== 0) throw startFailed(`Win32_Process.Createが${created.return_value}を返しました`)
  if (!validPid(created?.pid)) throw startFailed(`WMIの成功応答にpidがありません: ${String(stdout).slice(0, 200)}`)
  return created
}
// bootstrapが書くhandshake(外部processの出力)。pidか、typedな起動失敗のどちらかだけを受ける。
function readHandshake(file) {
  let answer
  try { answer = readJson(file) } catch (error) { throw startFailed(`bootstrapの応答を読めません: ${error.message}`) }
  if (typeof answer?.error === 'string') throw startFailed(answer.error)
  if (!validPid(answer?.pid)) throw startFailed(`bootstrapの応答にpidがありません: ${JSON.stringify(answer)}`)
  return answer.pid
}

// 起動したwatcherのpidを返す。logFileへstdout/stderrを追記し、stdinは閉じる。
export function launchDetached({ executable, args, cwd, env, logFile, onError }) {
  if (process.platform !== 'win32') {
    const fd = openSync(logFile, 'a', 0o600)
    try {
      const child = spawn(executable, args, { cwd, detached: true, stdio: ['ignore', fd, fd], env })
      child.on('error', onError)
      child.unref()
      return child.pid
    } finally { closeSync(fd) }
  }
  const handshake = join(resolve(logFile, '..'), 'watch.launch.json')
  rmSync(handshake, { force: true })
  const commandLine = windowsArgumentList([process.execPath, self, '--bootstrap', handshake, logFile, cwd, executable, ...args])
  const input = JSON.stringify({ commandLine, cwd, env: Object.entries(env).filter(([name, value]) => value !== undefined && !name.startsWith('=')).map(([name, value]) => `${name}=${value}`) })
  const run = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wmiCreate, 'utf16le').toString('base64')], { input, encoding: 'utf8', windowsHide: true })
  if (run.error?.code === 'ENOENT') throw failure('PARENT_PWSH7_MISSING')
  if (run.error || run.status !== 0) throw failure('PARENT_WATCH_START_FAILED', `WMI起動に失敗しました: ${run.error?.message ?? run.stderr.trim()}`)
  const created = parseWmiResult(run.stdout)
  const deadline = Date.now() + 15000
  while (!existsSync(handshake)) {
    if (Date.now() >= deadline) throw failure('PARENT_WATCH_START_FAILED', `bootstrap ${created.pid}の起動応答がありません`)
    pause(50)
  }
  const answer = readHandshake(handshake)
  rmSync(handshake, { force: true })
  return answer
}

// Windows bootstrap: Job外で起動され、watcherをlogへ結んだdetached子として起動してpidだけ返して終わる。
if (process.argv[2] === '--bootstrap' && process.argv[1] && resolve(process.argv[1]) === self) {
  const [handshake, logFile, cwd, executable, ...args] = process.argv.slice(3)
  const fail = (fd, error) => { if (fd !== undefined) closeSync(fd); atomicJson(handshake, { error: error.message }); process.exit(1) }
  let fd
  try { fd = openSync(logFile, 'a', 0o600) } catch (error) { fail(undefined, error) }
  try {
    const child = spawn(executable, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: process.env })
    child.once('error', error => fail(fd, error))
    child.once('spawn', () => { closeSync(fd); atomicJson(handshake, { pid: child.pid }); child.unref(); process.exit(0) })
  } catch (error) { fail(fd, error) }
}
