#!/usr/bin/env node
// Windows python3 の stdout は cp932 になり、日本語 JSON が room で壊れる。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const poster = resolve(root, 'skill/scripts/post-message.mjs')
const body = 'すずね再着席。監査はすずね。'
const utf8 = Buffer.from(JSON.stringify({ from: 'bell', to: 'all', body }), 'utf8')

const node = spawnSync(process.execPath, [poster, '--build-only', 'bell', 'all', body], { encoding: 'buffer' })
assert.equal(node.status, 0, node.stderr.toString('utf8'))
assert.ok(node.stdout.includes(Buffer.from('すずね', 'utf8')), 'node が UTF-8 で出さない')
assert.deepEqual(JSON.parse(node.stdout.toString('utf8')), { from: 'bell', to: 'all', body })

// 送信mode: 送信先を解決できない・受領できない時は必ず非ゼロで落ち、JSONを成功風に印字しない
// （印字をPOST成功と誤読して14時間未達になった 2026-08-26 の実被弾の再演）
const send = spawnSync(process.execPath, [poster, 'bell', 'all', body], {
  encoding: 'buffer', cwd: root,
  env: { ...process.env, PEERTABLE_URL: 'http://127.0.0.1:1', PEERTABLE_ROOM: 'norepro', PEERTABLE_POST_TOKEN: undefined },
})
assert.notEqual(send.status, 0, '未達なのに exit 0 になっている')
assert.ok(!send.stdout.includes(Buffer.from('すずね', 'utf8')), '未達時に本文JSONを stdout へ出している（成功と誤読される形）')

const py = spawnSync('python3', ['-c', 'import json,sys; print(json.dumps({"from":sys.argv[1],"to":sys.argv[2],"body":sys.argv[3]},ensure_ascii=False))', 'bell', 'all', body], { encoding: 'buffer' })
if (py.status === 0 && py.stdout.length > 0 && !py.stdout.includes(Buffer.from('すずね', 'utf8'))) {
  assert.ok(true, 'python3 stdout は UTF-8 ではない（cp932 経路）')
}

const change = readFileSync(resolve(root, 'skill/scripts/change-seat.sh'), 'utf8')
assert.match(change, /post-message\.mjs/)
assert.doesNotMatch(change, /json\.dumps\(\{"from":sys\.argv\[1\],"to":sys\.argv\[2\],"body":sys\.argv\[3\]\}/)

const parent = readFileSync(resolve(root, 'skill/templates/parent.md'), 'utf8')
assert.match(parent, /post-message\.mjs/)
assert.doesNotMatch(parent, /python3 -c 'import json,sys; print\(json\.dumps\(\{"from":sys\.argv\[1\]/)

console.log('post-message utf8 repro: green')
