#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildWindowsBridgeLaunch } from '../skill/scripts/platform/windows/build-bridge-command.mjs'

if (process.platform !== 'win32') {
  console.log('windows bridge launch repro: skipped (non-Windows)')
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'peertable-win-bridge-'))
try {
  const fixture = join(root, 'bridge fixture.mjs')
  const resultPath = join(root, 'result.json')
  const log = join(root, 'bridge output.log')
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify({ project: process.argv[2], arg: process.argv[3], env: process.env.PEERTABLE_PARENT_NAME }))\nconsole.log('fixture-complete')\n`)

  const launch = buildWindowsBridgeLaunch({
    script: fixture,
    project: resultPath,
    log,
    args: ['追加 引数'],
    env: { PEERTABLE_PARENT_NAME: "ベル's parent" },
  })
  assert.equal(launch.tmuxCommand.includes("ベル's parent"), false)
  const run = spawnSync(launch.command, launch.argv, { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), {
    project: resultPath,
    arg: '追加 引数',
    env: "ベル's parent",
  })
  assert.match(readFileSync(log, 'utf8'), /fixture-complete/)
  console.log('windows bridge launch repro: 5/5 green')
} finally {
  rmSync(root, { recursive: true, force: true })
}
