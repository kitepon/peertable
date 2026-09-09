#!/usr/bin/env node
// OS別の公開CLI起動を検証する。PTY backendの規則はAitermだけが所有する。
import assert from 'node:assert/strict'
import { resolveLatticeExecutable, resolveLatticeInvocation } from '../skill/scripts/seat-usage.mjs'
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


console.log('公開CLIのOS別起動: 5項目成功')
