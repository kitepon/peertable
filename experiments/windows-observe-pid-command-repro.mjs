import assert from 'node:assert/strict'
import { observePidCommand } from '../skill/scripts/seat-identity.mjs'

const observed = observePidCommand(process.pid)
assert.equal(observed.pid, process.pid)
assert.match(observed.argv, /windows-observe-pid-command-repro\.mjs/u)
assert.match(observed.started_identity, /^\d{4}-\d{2}-\d{2}T/u)
assert.match(observed.argv_digest, /^[0-9a-f]{64}$/u)
console.log('windows observePidCommand repro: 4/4 green')
