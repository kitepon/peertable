#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORWARDED_ENV = [
  'PEERTABLE_TMUX_SOCKET',
  'PEERTABLE_POST_TOKEN',
  'PEERTABLE_CREDENTIAL_FILE',
  'PEERTABLE_URL',
  'PEERTABLE_PARENT_NAME',
]

const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`

export function buildWindowsBridgeLaunch({
  script,
  project,
  log,
  args = [],
  env = process.env,
  node = process.execPath,
  pwsh = 'pwsh.exe',
} = {}) {
  if (!script || !project || !log) throw new Error('WINDOWS_BRIDGE_LAUNCH_ARGS_INVALID')

  const statements = []
  for (const name of FORWARDED_ENV) {
    const value = env[name]
    if (value) statements.push(`$env:${name} = ${quotePowerShell(value)}`)
  }
  const command = [node, script, project, ...args].map(quotePowerShell).join(' ')
  statements.push(`& ${command} *>> ${quotePowerShell(log)}`)
  statements.push('exit $LASTEXITCODE')
  const encoded = Buffer.from(statements.join('; '), 'utf16le').toString('base64')
  const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
  return {
    command: pwsh,
    argv,
    tmuxCommand: [pwsh, ...argv].join(' '),
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [script, project, log, ...args] = process.argv.slice(2)
  process.stdout.write(buildWindowsBridgeLaunch({ script, project, log, args }).tmuxCommand)
}
