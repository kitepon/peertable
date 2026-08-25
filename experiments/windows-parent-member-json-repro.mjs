import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../skill/scripts/platform/windows/parent-member-json.mjs', import.meta.url))
const result = spawnSync(process.execPath, [script, 'bell', '', '', 'codex', 'オーナー窓口'], { encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr)
const member = JSON.parse(result.stdout)
assert.deepEqual(member.roles, ['統括'])
assert.equal(member.mission, 'オーナー窓口')
console.log('windows parent member JSON repro: 2/2 green')
