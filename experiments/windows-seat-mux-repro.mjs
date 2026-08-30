#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  aitermPsmuxNamespace,
  resolveLatticeExecutable,
  resolveLatticeInvocation,
  tmuxArgv,
  usesPsmuxNamespace,
} from '../skill/scripts/seat-usage.mjs'

assert.equal(usesPsmuxNamespace({}, 'linux'), false)
assert.equal(usesPsmuxNamespace({}, 'win32'), true)
assert.equal(usesPsmuxNamespace({ PEERTABLE_FORCE_POSIX_TMUX: '1' }, 'win32'), false)
assert.equal(usesPsmuxNamespace({ AITERM_PSMUX_NS: 'aiterm-test' }, 'linux'), true)

const env = { TEMP: 'C:\\Users\\kite_\\AppData\\Local\\Temp' }
const expectedDir = path.win32.join(env.TEMP, 'claude-tmux-sockets')
const expectedNs = `aiterm-${createHash('sha1').update(expectedDir).digest('hex').slice(0, 12)}`
assert.equal(aitermPsmuxNamespace(env, 'win32'), expectedNs)
assert.equal(expectedNs, 'aiterm-d13d1ecda45a')

assert.deepEqual(tmuxArgv(['ls'], { socket: '/tmp/x.sock', env: {}, platform: 'linux' }), ['-S', '/tmp/x.sock', 'ls'])
assert.deepEqual(
  tmuxArgv(['ls'], { socket: '/tmp/x.sock', env: { AITERM_PSMUX_NS: 'aiterm-test' }, platform: 'linux' }),
  ['-L', 'aiterm-test', 'ls'],
)
assert.deepEqual(
  tmuxArgv(['has-session', '-t', 'peer-hotaru'], { env, platform: 'win32' }),
  ['-L', 'aiterm-d13d1ecda45a', 'has-session', '-t', 'peer-hotaru'],
)

assert.deepEqual(resolveLatticeExecutable('/opt/lattice', { platform: 'linux' }), {
  command: '/opt/lattice',
  argv: ['todo', 'status', '--json'],
})
const pwsh = 'C:/Program Files/PowerShell/7/pwsh.exe'
assert.deepEqual(
  resolveLatticeExecutable('C:/npm/lattice', { platform: 'win32', exists: (p) => p === 'C:/npm/lattice.ps1' }),
  {
    command: 'pwsh.exe',
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:/npm/lattice.ps1', 'todo', 'status', '--json'],
  },
)
assert.deepEqual(
  resolveLatticeExecutable('C:/npm/lattice.cmd', {
    platform: 'win32',
    exists: p => p === 'C:/npm/lattice.ps1',
  }),
  {
    command: 'pwsh.exe',
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:/npm/lattice.ps1', 'todo', 'status', '--json'],
  },
)
assert.deepEqual(
  resolveLatticeInvocation('C:/npm/lattice', ['status', '--json'], {
    platform: 'win32',
    exists: p => p === 'C:/npm/lattice.ps1',
    pwsh,
  }),
  {
    command: pwsh,
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:/npm/lattice.ps1', 'status', '--json'],
  },
)
assert.throws(
  () => resolveLatticeExecutable('C:/npm/lattice.cmd', { platform: 'win32', exists: () => false }),
  error => error?.code === 'PEERTABLE_WINDOWS_PWSH_SHIM_REQUIRED',
)

const liveNs = aitermPsmuxNamespace(process.env)
if (process.platform === 'win32') {
  const liveDir = path.win32.join(process.env.TMPDIR ?? process.env.TEMP ?? tmpdir(), 'claude-tmux-sockets')
  assert.equal(liveNs, `aiterm-${createHash('sha1').update(liveDir).digest('hex').slice(0, 12)}`)
}

console.log('windows seat mux repro: 13/13 green')
