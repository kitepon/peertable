// OSへの適合だけを集約する。所有者はPIDと開始identityの組で照合する。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readlinkSync, readdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const parentHome = () => join(homedir(), '.peertable', 'parent-receivers')
export const failure = (code, detail = code) => Object.assign(new Error(detail), { code })
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
export async function readHookEvent(stream) {
  // Windows CursorはBOMを付ける。stream decoderでUTF-8の文字途中の分割も扱う。
  stream.setEncoding('utf8')
  let raw = ''; for await (const chunk of stream) raw += chunk
  try { return JSON.parse(raw.replace(/^\uFEFF/u, '')) }
  catch { throw failure('PARENT_HOOK_INPUT_INVALID', '公式hookのJSON入力を解析できません') }
}
export function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temp, file)
}
export const psQuote = value => `'${String(value).replaceAll("'", "''")}'`
export const posixQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
export function shellCommand(executable, args, platform = process.platform) {
  return platform === 'win32' ? `& ${[executable, ...args].map(psQuote).join(' ')}` : [executable, ...args].map(posixQuote).join(' ')
}
// Windowsのcommand形式hookもPowerShell 7を明示して実行する。
export function hookCommand(executable, args, platform = process.platform) {
  if (platform !== 'win32') return shellCommand(executable, args, platform)
  const script = `${shellCommand(executable, args, platform)}; exit $LASTEXITCODE`
  return `pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}
export function windowsArgumentList(args) {
  return args.map(value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`).join(' ')
}
let ownIdentity = null
export function processIdentity(pid, { includeExecutable = true } = {}) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) throw failure('PARENT_PROCESS_ID_INVALID')
  if (Number(pid) === process.pid && ownIdentity && (!includeExecutable || ownIdentity.executable)) return ownIdentity
  const result = identity => {
    // 自分自身の開始identityはprocessの存命中に変わらない。他PIDは毎回OSへ照会する。
    if (identity.pid === process.pid) ownIdentity = identity
    return identity
  }
  try {
    if (process.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if($p){ @{pid=[int]$p.ProcessId; parent=[int]$p.ParentProcessId; started=$p.CreationDate.ToUniversalTime().ToString('o'); command=$p.CommandLine; executable=$p.ExecutablePath} | ConvertTo-Json -Compress }`
      const raw = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      if (!raw) return null
      const identity = JSON.parse(raw)
      if (identity.pid !== Number(pid) || !Number.isSafeInteger(identity.parent) || typeof identity.started !== 'string' || !identity.started || (includeExecutable && (typeof identity.executable !== 'string' || !identity.executable || typeof identity.command !== 'string'))) throw failure('PARENT_PROCESS_API_SCHEMA_INVALID')
      return result(identity)
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (!stat.startsWith(`${pid} (`) || !Number.isSafeInteger(Number(fields[1])) || !/^\d+$/u.test(fields[19] ?? '')) throw failure('PARENT_PROCESS_API_SCHEMA_INVALID')
      if (fields[0] === 'Z') return null
      const executable = includeExecutable ? readlinkSync(`/proc/${pid}/exe`) : null
      // 自動更新でunlinkされた実行中binaryは/procの実体を使い、kernelの表示用suffixを名前に混ぜない。
      const deleted = executable?.endsWith(' (deleted)')
      return result({ pid: Number(pid), parent: Number(fields[1]), started: `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`,
        executable: deleted ? `/proc/${pid}/exe` : executable,
        ...(deleted ? { executable_name: basename(executable.slice(0, -10)) } : {}),
        command: includeExecutable ? readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') : null })
    }
    const raw = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const match = /^(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/u.exec(raw)
    // macOSのps commは15文字で切れる。OSの開いているprogram textから実pathを取る。
    const executable = !includeExecutable ? null : Number(pid) === process.pid ? process.execPath
      : execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').find(line => line.startsWith('n/'))?.slice(1)
    if (!match || (includeExecutable && !executable)) throw failure('PARENT_PROCESS_API_SCHEMA_INVALID')
    return result({ pid: Number(pid), parent: Number(match[1]), started: match[2], executable, command: match[3] })
  } catch (error) {
    if (process.platform === 'linux' && error.code === 'ENOENT' && String(error.path).startsWith(`/proc/${pid}/`)) {
      try { readFileSync(`/proc/${pid}/stat`) }
      catch (probe) { if (probe.code === 'ENOENT') return null; throw failure('PARENT_PROCESS_API_FAILED', probe.message) }
    }
    if (process.platform === 'darwin' && error.status === 1) {
      try { execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch (probe) { if (probe.status === 1 && !String(probe.stdout ?? '').trim() && !String(probe.stderr ?? '').trim()) return null; throw failure('PARENT_PROCESS_API_FAILED', probe.message) }
    }
    if (error.code === 'ENOENT' && process.platform === 'win32') throw failure('PARENT_PWSH7_MISSING')
    if (error.code?.startsWith('PARENT_')) throw error
    throw failure('PARENT_PROCESS_API_FAILED', `PID ${pid}: ${error.message}`)
  }
}
export const sameProcess = owner => owner && processIdentity(owner.pid, { includeExecutable: false })?.started === owner.started
export function processDescendsFrom(owner, ancestor) {
  if (!sameProcess(owner) || !sameProcess(ancestor)) return false
  for (let pid = owner.pid, depth = 0; pid > 0 && depth < 32; depth++) {
    const identity = processIdentity(pid, { includeExecutable: false })
    if (!identity) return false
    if (identity.pid === ancestor.pid) return identity.started === ancestor.started
    if (identity.parent === pid) return false
    pid = identity.parent
  }
  return false
}
export function processHarness(identity) {
  const executable = (identity.executable_name ?? basename(identity.executable ?? '')).toLowerCase()
  const native = { 'claude': 'claude', 'claude.exe': 'claude', 'codex': 'codex', 'codex.exe': 'codex', 'grok': 'grok', 'grok.exe': 'grok', 'cursor-agent': 'cursor', 'cursor.exe': 'cursor', 'cursor': 'cursor' }
  if (native[executable]) return native[executable]
  if (/^grok-(?:macos|linux)-(?:aarch64|x86_64)$/u.test(executable)) return 'grok'
  if (executable !== 'node' && executable !== 'node.exe') return null
  // Node直下の実entryだけを読む。shell -cや後続引数に含まれる名前は本人の根拠にしない。
  const tokens = (identity.command ?? '').match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? []
  let index = 1
  // 公式CursorはNodeの--use-system-caをentryの前に置く。評価式やpreloadはmain scriptとして扱わない。
  const flags = new Set(['--use-system-ca', '--no-warnings', '--no-deprecation', '--enable-source-maps'])
  const valued = new Set(['--require', '-r', '--import', '--conditions', '-C'])
  for (; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--') { index++; break }
    if (flags.has(token)) continue
    if (valued.has(token)) { index++; continue }
    if ([...valued].some(flag => token.startsWith(`${flag}=`))) continue
    if (token.startsWith('-')) return null
    break
  }
  const script = tokens[index]?.replace(/^['"]|['"]$/gu, '') ?? ''
  if (/@anthropic-ai[/\\]claude-code[/\\](?:cli\.js|bin[/\\]claude)/u.test(script)) return 'claude'
  if (/@openai[/\\]codex[/\\]bin[/\\]codex\.js$/u.test(script)) return 'codex'
  if (/cursor-agent[/\\]versions[/\\][^/\\]+[/\\](?:index\.js|cursor-agent)$/u.test(script)) return 'cursor'
  if (/grok-cli[/\\](?:dist[/\\])?(?:index|cli)\.js$/u.test(script)) return 'grok'
  return null
}
export function harnessProcess(harness, start = process.ppid, { identify = processIdentity } = {}) {
  for (let pid = start, depth = 0; pid > 1 && depth < 24; depth++) {
    // system/initの親を本人候補にしない。Windowsのsystem processにExecutablePathが無くても所有者探索は終了できる。
    const ancestry = identify(pid, { includeExecutable: false })
    if (!ancestry || ancestry.parent <= 0 || ancestry.parent === pid) return null
    const identity = identify(pid)
    if (!identity) return null
    const detected = processHarness(identity)
    if (detected) return detected === harness ? identity : null
    if (identity.parent === pid) return null
    pid = identity.parent
  }
  return null
}
export function codexPackageExecutable(packageRoot, { platform = process.platform, arch = process.arch } = {}) {
  const manifest = readJson(join(packageRoot, 'package.json'))
  if (manifest.name !== '@openai/codex' || !manifest.bin?.codex) throw failure('PARENT_CODEX_PACKAGE_INVALID')
  const packageName = `@openai/codex-${platform}-${arch}`
  if (!Object.hasOwn(manifest.optionalDependencies ?? {}, packageName)) throw failure('PARENT_CODEX_PLATFORM_UNSUPPORTED')
  const require = createRequire(join(packageRoot, manifest.bin.codex))
  const platformRoot = dirname(require.resolve(`${packageName}/package.json`))
  const nativeManifest = readJson(join(platformRoot, 'package.json'))
  if (nativeManifest.os && !nativeManifest.os.includes(platform)) throw failure('PARENT_CODEX_PACKAGE_PLATFORM_MISMATCH')
  const vendor = join(platformRoot, 'vendor')
  const binaries = readdirSync(vendor).map(target => join(vendor, target, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')).filter(existsSync)
  if (binaries.length !== 1) throw failure('PARENT_CODEX_NATIVE_EXECUTABLE_UNRESOLVED')
  return binaries[0]
}
export function resolveExecutable(name) {
  if (process.platform !== 'win32') {
    const paths = (process.env.PATH ?? '').split(':')
    const found = paths.map(path => join(path, name)).find(existsSync)
    if (!found) throw failure('PARENT_EXECUTABLE_MISSING', `${name}が見つかりません`)
    return found
  }
  const script = `$c=Get-Command ${psQuote(name)} -ErrorAction Stop; $c.Source`
  const path = execFileSync('pwsh.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
  if (/\.ps1$/iu.test(path)) {
    // npmのshimではなく公式native実体を選ぶ。実体の候補を推測して呼び出さない。
    const content = readFileSync(path, 'utf8')
    if (name === 'codex') {
      const relative = /\$basedir[\\/]([^"\r\n]*@openai[\\/]codex[\\/]bin[\\/]codex\.js)/u.exec(content)?.[1]
      if (!relative) throw failure('PARENT_CODEX_NPM_ENTRY_UNRESOLVED')
      return codexPackageExecutable(dirname(dirname(join(dirname(path), relative))))
    }
    const exe = [...content.matchAll(/\$basedir[\\/]([^"\r\n]+\.exe)/gu)].map(match => join(dirname(path), match[1])).find(existsSync)
    if (exe) return exe
    throw failure('PARENT_NATIVE_EXECUTABLE_UNRESOLVED', `${path}の公式実体を解決できません`)
  }
  return path
}
