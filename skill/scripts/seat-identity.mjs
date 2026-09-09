// Peertable自身のbridge processを照合するためのOS観測。席のPTYはAitermが観測する。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { observeWindowsPidCommand, parseWindowsCreationDate } from './platform/windows/observe-pid-command.mjs'

export function hashArgv(argv) {
  return createHash('sha256').update(String(argv), 'utf8').digest('hex')
}

// 記録済み pid そのものの lstart / argv を観測する（pane からの席特定はしない）。
// 自製bridgeの停止前照合に使う。
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

export const parseWinCreationDate = parseWindowsCreationDate
const psEnv = () => ({ ...process.env, LC_ALL: 'C' })
