export function resolveWindowsCommand(cli, argv, {
  platform = process.platform,
  exists,
  comspec = process.env.ComSpec || 'cmd.exe',
} = {}) {
  if (platform !== 'win32') return { command: cli, argv }
  const lower = cli.toLowerCase()
  const shim = lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.exe')
    ? cli
    : exists?.(`${cli}.cmd`)
      ? `${cli}.cmd`
      : cli
  if (/\.exe$/i.test(shim)) return { command: shim, argv }
  return { command: comspec, argv: ['/d', '/c', shim, ...argv] }
}

export function resolveWindowsLatticeCommand(cli, exists) {
  return resolveWindowsCommand(cli, ['todo', 'status', '--json'], { exists })
}
