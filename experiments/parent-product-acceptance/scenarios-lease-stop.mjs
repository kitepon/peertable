#!/usr/bin/env node
// 3OS共通の専用run停止入口。Windowsでcontrollerを強制killしない。
import { readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runnerProvenance } from './runner-provenance.mjs'
import { requestLeaseStop } from './scenarios-cancellation.mjs'

export async function stopLeaseOnly({ out, runnerCommit }) {
  const runner = runnerProvenance(dirname(fileURLToPath(import.meta.url)), runnerCommit)
  const descriptor = JSON.parse(readFileSync(join(resolve(out), 'private/lease-control.json'), 'utf8'))
  const platform = await import(pathToFileURL(join(descriptor.pkg, 'skill/scripts/parent-platform.mjs')).href)
  return requestLeaseStop({ out, runner, platform })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), flags = {}
  for (let index = 0; index < args.length; index += 2) { if (!['--out', '--runner-commit'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw Object.assign(new Error('停止入口には--out/--runner-commitが必要です'), { code: 'ACCEPTANCE_LEASE_STOP_ARGUMENT' }); flags[args[index].slice(2)] = args[index + 1] }
  if (!flags.out || !flags['runner-commit']) throw Object.assign(new Error('停止入口には--out/--runner-commitが必要です'), { code: 'ACCEPTANCE_LEASE_STOP_ARGUMENT' })
  process.stdout.write(JSON.stringify(await stopLeaseOnly({ out: flags.out, runnerCommit: flags['runner-commit'] })) + '\n')
}
