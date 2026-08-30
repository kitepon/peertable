export function resolveWindowsCommand(cli, argv, {
  platform = process.platform,
  exists,
  pwsh = 'pwsh.exe',
} = {}) {
  if (platform !== 'win32') return { command: cli, argv }
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
