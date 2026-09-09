#!/usr/bin/env node
// 公開Aiterm MCPへ実接続して、Peertable常駐の初回・再実行・更新を確認する。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermClient } from '../skill/scripts/aiterm-client.mjs'
import { bridgeKinds, bridgeSession, ensureProjectRuntime } from '../skill/scripts/ensure-project-runtime.mjs'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peertable-public-runtime-')))
const project = join(dir, 'project'), root = join(dir, 'package')
const room = 'public-runtime-smoke'
mkdirSync(join(project, '.team'), { recursive: true })
mkdirSync(join(root, 'skill', 'scripts'), { recursive: true })
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'peertable', version: '1.0.0' }))
writeFileSync(join(root, 'skill', 'scripts', 'runtime-digest.mjs'), "process.stdout.write('a'.repeat(64))")
writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({ room, mode: 'standalone', plan_key: '', server_url: 'http://127.0.0.1' }))
for (const kind of bridgeKinds) {
  writeFileSync(join(root, 'skill', 'scripts', `${kind}-bridge.mjs`), `
import { existsSync,readFileSync,unlinkSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
const file=join(process.argv[2],'.team',${JSON.stringify(`${kind}-bridge.json`)})
if(process.argv.includes('--stop')) {
  if(existsSync(file)) { const r=JSON.parse(readFileSync(file)); process.kill(r.pid,'SIGTERM'); if(existsSync(file))unlinkSync(file) }
  process.exit(0)
}
const stamp=new Date().toISOString()
writeFileSync(file,JSON.stringify({pid:process.pid,ready_at:stamp,last_progress_at:stamp}))
process.on('SIGTERM',()=>process.exit(0))
setInterval(()=>{},1000)
`)
}
const tokenSource = join(dir, 'fixture.env')
writeFileSync(tokenSource, 'PEERTABLE_POST_TOKEN=public-runtime-fixture\n', { mode: 0o600 })
const env = { ...process.env, PEERTABLE_TOKEN_SOURCE_FILE: tokenSource }
delete env.PEERTABLE_POST_TOKEN
delete env.PEERTABLE_CREDENTIAL_FILE
const aiterm = new AitermClient({ env })
try {
  writeFileSync(join(project, '.team', 'alarm-bridge.log'), 'WRITE_DENIED: 過去の資格では拒否された\n')
  const first = await ensureProjectRuntime(project, { root, aiterm, env })
  assert.deepEqual(first.bridges.map(bridge => bridge.status), ['started', 'started', 'started'])
  const firstPids = bridgeKinds.map(kind => JSON.parse(readFileSync(join(project, '.team', `${kind}-bridge.json`))).pid)
  const second = await ensureProjectRuntime(project, { root, aiterm, env })
  assert.ok(second.bridges.every(bridge => bridge.status === 'current'))
  assert.deepEqual(bridgeKinds.map(kind => JSON.parse(readFileSync(join(project, '.team', `${kind}-bridge.json`))).pid), firstPids)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'peertable', version: '2.0.0' }))
  const update = await ensureProjectRuntime(project, { root, aiterm, env })
  assert.ok(update.bridges.every(bridge => bridge.status === 'updated'))
  assert.ok(bridgeKinds.every(kind => JSON.parse(readFileSync(join(project, '.team', `${kind}-bridge.json`))).peertable_version === '2.0.0'))
  console.log(JSON.stringify({ schema: 'peertable.public-runtime-smoke.v1', status: 'pass', platform: process.platform,
    checks: ['past-error-does-not-block-retry', 'initial-ready', 'repeat-keeps-pid', 'update-restarts-and-reads-ready'], backend_commands: false }))
} finally {
  for (const kind of bridgeKinds) await aiterm.call('pty_close', { session_id: bridgeSession(project, room, kind) })
  await aiterm.close()
  rmSync(dir, { recursive: true, force: true })
}
