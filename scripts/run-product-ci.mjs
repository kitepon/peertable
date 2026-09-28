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

function scriptsWithExtension(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return scriptsWithExtension(file, extension)
    return file.endsWith(extension) ? [file] : []
  })
}

for (const directory of ['room', 'skill/scripts', 'scripts']) {
  for (const file of scriptsWithExtension(path.join(root, directory), '.mjs')) run(process.execPath, ['--check', file])
}
run(process.execPath, ['--test', 'skill/scripts/runtime-contract.test.mjs'])
run(process.execPath, ['experiments/aiterm-unified-delivery-repro.mjs'])
run(process.execPath, ['--test', 'scripts/ci-contract.test.mjs', 'scripts/docs-contract.test.mjs'])
run(process.execPath, ['--test', 'skill/scripts/parent-delivery.test.mjs', 'skill/scripts/parent-runtime-probe.test.mjs', 'skill/scripts/parent-source-runtime.test.mjs', 'skill/scripts/parent-process.test.mjs', 'skill/scripts/parent-platform-atomic.test.mjs', 'skill/scripts/parent-platform-unlinked-executable.test.mjs', 'room/parent-client.test.mjs', 'scripts/parent-delivery-acceptance.test.mjs'])
run(process.execPath, ['experiments/delivery-receipt-repro.mjs'])
run(process.execPath, ['experiments/http-utf8-body-repro.mjs'])
run(process.execPath, ['experiments/windows-seat-mux-repro.mjs'])
run(process.execPath, ['experiments/seat-placement-repro.mjs'])

if (process.platform !== 'win32') {
  for (const file of scriptsWithExtension(path.join(root, 'skill/scripts'), '.sh')) run('bash', ['-n', file])
}

run(process.execPath, ['room/client.mjs', 'diagnostics'], {
  env: { ...process.env, PEERTABLE_URL: '' },
})
