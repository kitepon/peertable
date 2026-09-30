#!/usr/bin/env node
// 罠: setup-state の lattice_cli が空だと、alarm-bridge が lattice_task_ready を評価せずに飛ばしていた
// （kitepon-books で7件が一度も鳴らなかった、2026-09-30）。他のbridgeと同じく PATH 上の lattice へ落とす。
// 見本の launchd が開発用 clone を起動して古い版で巡回していた罠も、ここで止める。
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let ok = true
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

const plist = readFileSync(join(root, 'skill/launchd/dev.kitepon.peertable-bridges.plist'), 'utf8')
check('launchd の見本は npm で導入した版を起動する',
  plist.includes('/node_modules/peertable/skill/scripts/ensure-all-bridges.sh') && !plist.includes('/Developer/peertable/'))

const dir = mkdtempSync(join(tmpdir(), 'peertable-alarm-lattice-'))
const project = join(dir, 'project')
const bin = join(dir, 'bin')
mkdirSync(join(project, '.team', 'alarms'), { recursive: true })
mkdirSync(bin)
writeFileSync(join(bin, 'lattice'), `#!/bin/sh\necho '{"next_ready":[{"task_id":"T01","plan_key":"fixture-plan"}],"active_set":[]}'\n`)
chmodSync(join(bin, 'lattice'), 0o755)

const posted = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    posted.push({ url: req.url, token: req.headers['x-peertable-token'], body: JSON.parse(body || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"seq":1}')
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({
  room: 'fixture', server_url: `http://127.0.0.1:${server.address().port}`, mode: 'lattice', lattice_cli: '',
}))
writeFileSync(join(project, '.team', 'alarms', 'fixture.json'), JSON.stringify({
  seat: 'rin', note: 'T01 が ready', interval_s: 2,
  condition: { type: 'lattice_task_ready', task_id: 'T01', plan_key: 'fixture-plan' },
}))

const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PEERTABLE_POST_TOKEN: 'fixture-token' }
delete env.LATTICE_CLI
const bridge = spawn(process.execPath, [join(root, 'skill/scripts/alarm-bridge.mjs'), project], { env, stdio: ['ignore', 'ignore', 'pipe'] })
let log = ''
bridge.stderr.on('data', chunk => { log += chunk })
const deadline = Date.now() + 15_000
while (!posted.length && Date.now() < deadline) await new Promise(done => setTimeout(done, 200))
bridge.kill('SIGTERM')
server.close()
rmSync(dir, { recursive: true, force: true })

check('lattice_cli が空でも PATH の lattice で条件を評価して起こす',
  posted.length === 1 && posted[0].url === '/api/fixture/messages' && posted[0].body.to === 'rin'
    && posted[0].token === 'fixture-token',
  JSON.stringify(posted))
check('評価失敗を記録しない', !log.includes('ALARM_CONDITION_EVALUATION_FAILED'), log.trim().split('\n').slice(-2).join(' / '))

console.log(ok ? 'alarm lattice_cli fallback repro: green' : 'alarm lattice_cli fallback repro: RED')
process.exit(ok ? 0 : 1)
