import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const adapter = fileURLToPath(new URL('../skill/scripts/platform/windows/normalize-read-line.mjs', import.meta.url))
for (const [input, expected] of [
  ['.lattice/runs/first\r', '.lattice/runs/first'],
  ['.lattice/runs/last', '.lattice/runs/last'],
]) {
  const result = spawnSync(process.execPath, [adapter], { input, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, expected)
}

console.log('windows CRLF run ref repro: 2/2 green')
