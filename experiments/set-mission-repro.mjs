#!/usr/bin/env node
// 席 mission 更新の再現ハーネス。
//
// 測るのは set-mission.sh の契約:
//   members.mission が書き換わる / 他欄は保つ / room に [mission] が1行残る /
//   席 process を殺さない（tmux kill / leave-seat / launch-seat を呼ばない） /
//   欠員は新規 member を作らない。
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bash = process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash'
const root = await mkdtemp(join(tmpdir(), 'peertable-set-mission-'))
const project = join(root, 'project')
const scripts = join(root, 'scripts')
const bin = join(root, 'bin')
const data = join(root, 'data')
const killLog = join(root, 'kill.log')
const credentialHelper = join(root, 'seat-credential.mjs')
const port = 19300 + Math.floor(Math.random() * 500)
const base = `http://127.0.0.1:${port}`
const token = 'test-token'
const mission = 'phase8a-input-studio-dist 実装'

await Promise.all([
  mkdir(join(project, '.team'), { recursive: true }),
  mkdir(scripts),
  mkdir(bin),
  mkdir(data),
])
await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({
  room: 'fixture',
  server_url: base,
}) + '\n')
for (const script of ['set-mission.sh', 'post-message.mjs']) {
  await cp(join(REPO, 'skill/scripts', script), join(scripts, script))
}
await chmod(join(scripts, 'set-mission.sh'), 0o755)
await writeFile(join(scripts, 'leave-seat.sh'), `#!/bin/bash
echo leave "$@" >> "$KILL_LOG"
exit 9
`)
await writeFile(join(scripts, 'launch-seat.sh'), `#!/bin/bash
echo launch "$@" >> "$KILL_LOG"
exit 9
`)
await chmod(join(scripts, 'leave-seat.sh'), 0o755)
await chmod(join(scripts, 'launch-seat.sh'), 0o755)
await writeFile(join(bin, 'tmux'), `#!/bin/bash
echo tmux "$@" >> "$KILL_LOG"
exit 1
`)
await chmod(join(bin, 'tmux'), 0o755)

await writeFile(credentialHelper, `#!/usr/bin/env node
const [action, ...args] = process.argv.slice(2)
if (action === 'path') process.stdout.write(args[0] + '/.team/fixture.token\\n')
else if (action === 'request') {
  const response = await fetch(args[2], {
    method: args[1],
    headers: { 'content-type': 'application/json', 'X-Peertable-Token': ${JSON.stringify(token)} },
    ...(args[3] ? { body: args[3] } : {}),
  })
  const responseBody = await response.text()
  if (!response.ok) process.exit(1)
  process.stdout.write(responseBody)
} else process.exit(2)
`)

const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: token },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const env = {
  ...process.env,
  PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  PEERTABLE_POST_TOKEN: token,
  PEERTABLE_CREDENTIAL_HELPER: credentialHelper,
  KILL_LOG: killLog,
}

const api = async (path, init) => {
  const res = await fetch(`${base}/api/fixture/${path}`, init)
  assert.ok(res.ok, `${path}: HTTP ${res.status}`)
  return res.json()
}
let ready = false
for (let i = 0; i < 50; i++) {
  try { await api('members'); ready = true; break } catch { await new Promise(r => setTimeout(r, 40)) }
}
assert.equal(ready, true, 'fixture room serverが起動する')

const member = body => api('members', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Peertable-Token': token },
  body: JSON.stringify({
    name: 'koharu',
    vendor: 'claude',
    model: 'opus',
    effort: 'high',
    role: '実装',
    mission: 'phase5-unverified の A',
    ...body,
  }),
})
const seat = async () => (await api('members')).members.find(x => x.name === 'koharu')
const run = (args, extra = {}) => spawnSync(bash, [join(scripts, 'set-mission.sh'), project, ...args], {
  env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000,
})
const killLines = async () => {
  if (!existsSync(killLog)) return []
  return (await readFile(killLog, 'utf8')).trim().split('\n').filter(Boolean)
}
let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok: ${label}`) }

try {
  await member()

  const missing = run(['ghost', mission])
  check('欠員は新規 member を作らず止まる', () => {
    assert.notEqual(missing.status, 0, missing.stdout)
    assert.match(missing.stderr, /SET_MISSION_MEMBER_MISSING/)
  })
  const listing = await api('members')
  check('欠員呼び出しで ghost は増えない', () => {
    assert.equal(listing.members.some(m => m.name === 'ghost'), false)
    assert.equal(listing.members.length, 1)
  })

  const result = run(['koharu', mission])
  check('mission 更新が通る', () => {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /SET_MISSION_OK: koharu mission=phase8a-input-studio-dist 実装/)
  })
  const after = await seat()
  check('members.mission が書き換わる', () => {
    assert.equal(after.mission, mission)
  })
  check('他の素性欄は保つ', () => {
    assert.equal(after.vendor, 'claude')
    assert.equal(after.model, 'opus')
    assert.equal(after.effort, 'high')
    assert.deepEqual(after.roles, ['実装'])
  })
  const messages = (await api('messages')).messages.filter(m => m.from !== 'system')
  check('room に [mission] が1行残る', () => {
    const lines = messages.filter(m => String(m.body).startsWith('[mission] '))
    assert.equal(lines.length, 1, JSON.stringify(messages))
    assert.equal(lines[0].from, 'koharu')
    assert.equal(lines[0].to, 'all')
    assert.equal(lines[0].body, `[mission] koharu: ${mission}`)
  })
  const killed = await killLines()
  check('席 process を殺さない（tmux / leave-seat / launch-seat を呼ばない）', () => {
    assert.deepEqual(killed, [])
  })

  const invalid = run([])
  check('引数不足は typed に止まる', () => {
    assert.equal(invalid.status, 2)
    assert.match(invalid.stderr, /SET_MISSION_ARGS_INVALID/)
  })

  console.log(`set-mission repro: ${checks} checks green`)
} finally {
  server.kill('SIGTERM')
  await rm(root, { recursive: true, force: true })
}
