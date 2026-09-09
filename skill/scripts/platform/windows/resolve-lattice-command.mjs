import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export function resolveWindowsCommand(cli, argv, {
  platform = process.platform,
  exists = existsSync,
  pathEnv = process.env.PATH ?? '',
  pwsh = 'pwsh.exe',
} = {}) {
  if (platform !== 'win32') return { command: cli, argv }
  if (!/[\\/]/u.test(cli)) {
    for (const directory of pathEnv.split(';').filter(Boolean)) {
      const candidates = /\.(?:exe|ps1|cmd|bat)$/iu.test(cli) ? [cli] : [`${cli}.exe`, `${cli}.ps1`]
      const found = candidates.map(name => win32.join(directory, name)).find(exists)
      if (found) { cli = found; break }
    }
  }
  const lower = cli.toLowerCase()
  if (lower.endsWith('.exe')) return { command: cli, argv }

  const ps1 = lower.endsWith('.ps1')
    ? cli
    : /\.(?:cmd|bat)$/iu.test(cli)
      ? `${cli.slice(0, -4)}.ps1`
      : `${cli}.ps1`
  if (!exists?.(ps1)) {
    const error = new Error(`PowerShell 7 shimが見つかりません: ${ps1}`)
    error.code = 'PEERTABLE_WINDOWS_PWSH_SHIM_REQUIRED'
    throw error
  }
  return {
    command: pwsh,
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', ps1, ...argv],
  }
}

export function resolveWindowsLatticeCommand(cli, exists, { pwsh = 'pwsh.exe' } = {}) {
  return resolveWindowsCommand(cli, ['todo', 'status', '--json'], {
    platform: 'win32',
    exists,
    pwsh,
  })
}
