#!/usr/bin/env node
// Peertable スクリプト群の OS プロセス観測ライブラリ（唯一の所有者）。
// pane_pid から Lattice attach 用の pid / lstart / argv を1件に決める CLI を兼ねる。
// POSIX は ps。Windows は Win32_Process（ps -Ao は Git Bash で unknown option -- A）。
// ps の観測規約（LC_ALL=C・/bin/ps 絶対パス・trim）と argv digest の計算はこのファイルだけが持つ。
// 他スクリプトはここから import し、ps を手書きしない（locale 罠の再発防止。caveat:
// ps-locale-lstart-lc-time-ascii-argv-lc-ctype-digest）。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { observeWindowsPidCommand, parseWindowsCreationDate } from './platform/windows/observe-pid-command.mjs'

export function hashArgv(argv) {
  return createHash('sha256').update(String(argv), 'utf8').digest('hex')
}

// 記録済み pid そのものの lstart / argv を観測する（pane からの席特定はしない）。
// refresh-seat-identity・doctor が使う。
export function observePidCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    const error = new Error('pid が正整数でない')
    error.code = 'SEAT_IDENTITY_NO_PID'
    throw error
  }
  if (process.platform === 'win32') return observeWindowsPidCommand(pid, hashArgv)
  const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: psEnv() }).trim()
  const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: psEnv() }).trim()
  if (!started || !argv) {
    const error = new Error('pid の lstart/command を観測できない')
    error.code = 'SEAT_IDENTITY_UNOBSERVABLE'
    throw error
  }
  return { pid, started_identity: started, argv, argv_digest: hashArgv(argv) }
}

const AGENT = /(?:claude|codex|grok|composer)(?:\.cmd|\.exe)?(?:\s|$)/iu

export const parseWinCreationDate = parseWindowsCreationDate

// ps の lstart 書式（LC_TIME）と非ASCII argv のエスケープ（LC_CTYPE）は locale で変わり、
// 観測者ごとに digest が割れる（2026-08-22 実測）。Lattice 側の観測も LC_ALL=C に固定している。
const psEnv = () => ({ ...process.env, LC_ALL: 'C' })

function posixIdentity(pid) {
  const table = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,pgid='], { encoding: 'utf8', env: psEnv() })
  const leaders = table.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line)
    if (!match) return []
    const [, child, ppid, pgid] = match
    return ppid === String(pid) && child === pgid ? [child] : []
  })
  const chosen = leaders.length === 1 ? leaders[0] : String(pid)
  const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', chosen], { encoding: 'utf8', env: psEnv() }).trim()
  const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', chosen], { encoding: 'utf8', env: psEnv() }).trim()
  if (!started || !argv) throw new Error('pid の lstart/args を観測できない')
  return { pid: Number(chosen), started_identity: started, argv, argv_digest: hashArgv(argv) }
}

function winQuery(filter) {
  const script = `Get-CimInstance Win32_Process -Filter ${JSON.stringify(filter)} | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`
  const out = execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim()
  if (!out) return []
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function winIdentity(pid) {
  const self = winQuery(`ProcessId=${pid}`)[0]
  if (!self) throw new Error('Win32_Process を観測できない')
  const children = winQuery(`ParentProcessId=${pid}`)
  const agentKids = children.filter((row) => AGENT.test(String(row.CommandLine || '')))
  let chosen = self
  if (AGENT.test(String(self.CommandLine || ''))) chosen = self
  else if (agentKids.length === 1) chosen = agentKids[0]
  else if (children.length === 1) chosen = children[0]
  const started = chosen.CreationDate ? parseWinCreationDate(chosen.CreationDate) : ''
  const argv = String(chosen.CommandLine || '').trim()
  if (!started || !argv) throw new Error('pid の CreationDate/CommandLine を観測できない')
  return { pid: Number(chosen.ProcessId), started_identity: started, argv, argv_digest: hashArgv(argv) }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  const panePid = process.argv[2]
  if (!/^\d+$/.test(panePid || '')) {
    console.error('usage: seat-identity.mjs <pane_pid>')
    process.exit(2)
  }
  try {
    const ident = process.platform === 'win32' ? winIdentity(panePid) : posixIdentity(panePid)
    process.stdout.write(`${JSON.stringify(ident)}\n`)
  } catch (error) {
    console.error(error.message || error)
    process.exit(1)
  }
}
