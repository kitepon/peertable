#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function shellScripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return shellScripts(file)
    return file.endsWith('.sh') ? [file] : []
  })
}

run(process.execPath, ['--check', 'room/server.mjs'])
run(process.execPath, ['--check', 'room/client.mjs'])
run(process.execPath, ['--test', 'skill/scripts/runtime-contract.test.mjs'])
run(process.execPath, ['--test', 'scripts/ci-contract.test.mjs', 'scripts/docs-contract.test.mjs'])
run(process.execPath, ['experiments/windows-seat-mux-repro.mjs'])
run(process.execPath, ['experiments/seat-placement-repro.mjs'])

if (process.platform !== 'win32') {
  for (const file of shellScripts(path.join(root, 'skill/scripts'))) run('bash', ['-n', file])
}

run(process.execPath, ['room/client.mjs', 'diagnostics'], {
  env: { ...process.env, PEERTABLE_URL: '' },
})
