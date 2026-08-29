#!/usr/bin/env node
// cmd.exe は `VAR= cmd` を解釈しない。publish gate を Node から起動する。
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const run = (args) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PEERTABLE_URL: '' },
  })
  if (result.status) process.exit(result.status ?? 1)
}
run(['--test', join(root, 'skill/scripts/runtime-contract.test.mjs')])
run([join(root, 'scripts/verify-release-commit.mjs')])
run([join(root, 'room/client.mjs'), 'diagnostics'])
