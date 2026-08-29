#!/usr/bin/env node
// teardownがalarm-bridgeを止めず、Windowsでalarm-bridge.logを保持したまま.team削除に失敗した退行を止める。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../skill/scripts/teardown.sh', import.meta.url), 'utf8')
const stop = source.indexOf('alarm-bridge.mjs" "$proj" --stop')
const remove = source.indexOf('rm -rf "$proj/.team"')

assert.ok(stop >= 0, 'teardown must invoke alarm-bridge --stop')
assert.ok(remove >= 0 && stop < remove, 'alarm-bridge must stop before .team removal')
assert.match(source, /did "alarm-bridge 停止"/, 'successful stop must be reported')
assert.match(source, /miss "alarm-bridge 停止に失敗/, 'failed stop must remain visible and non-green')

console.log('teardown alarm stop repro: green')
