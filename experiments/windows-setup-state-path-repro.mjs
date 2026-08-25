import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'peertable-windows-state-'))
try {
  const output = join(root, 'setup-state.json')
  const writer = fileURLToPath(new URL('../skill/scripts/platform/windows/write-setup-state.mjs', import.meta.url))
  const lattice = 'C:\\Users\\kite_\\AppData\\Roaming\\npm\\lattice'
  const result = spawnSync(process.execPath, [writer, output, 'room', 'http://room', 'https://room',
    'lattice', 'plan', '[]', 'false', 'true', 'false', 'false', 'true', 'false', 'true', 'true',
    'false', '', lattice], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).lattice_cli, lattice)
  console.log('windows setup-state path repro: 1/1 green')
} finally {
  rmSync(root, { recursive: true, force: true })
}
