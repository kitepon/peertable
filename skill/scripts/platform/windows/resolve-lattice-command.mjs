export function resolveWindowsLatticeCommand(cli, exists) {
  const lower = cli.toLowerCase()
  const shim = lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.exe')
    ? cli
    : exists(`${cli}.cmd`)
      ? `${cli}.cmd`
      : cli
  return { command: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/c', shim, 'todo', 'status', '--json'] }
}
