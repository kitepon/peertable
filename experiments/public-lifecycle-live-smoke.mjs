#!/usr/bin/env node
// 実CLI・実room・Aiterm公開APIによる手動試験。偽harnessは使用しない。
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AitermClient } from '../skill/scripts/aiterm-client.mjs'

const execute = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function liveSmoke({ harness, model, nextModel = model, effort = 'high', nextEffort = 'medium', stopProbe = false }) {
  assert.ok(harness && model, 'harnessとmodelを明示してください')
  assert.ok(!stopProbe || process.platform !== 'win32', 'SIGSTOP試験はPOSIX専用です')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'peertable-public-live-')))
  const project = join(root, 'project')
  const room = `public-live-${process.pid}`
  const member = `live-${process.pid}`
  const sessionId = `peer-${member}`
  const token = `fixture-${process.pid}-${Date.now()}`
  const tokenFile = join(root, 'credential.env')
  const tasksFile = join(root, 'tasks.md')
  const originalMcp = '{ "mcpServers": {} }\n'
  await mkdir(project)
  await writeFile(join(project, '.mcp.json'), originalMcp)
  await writeFile(tokenFile, `PEERTABLE_POST_TOKEN=${token}\n`, { mode: 0o600 })
  await writeFile(tasksFile, '# 実機確認\n\n- roomの投稿と配達を確認する。\n')
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const env = { ...process.env, PEERTABLE_TOKEN_SOURCE_FILE: tokenFile }
  delete env.PEERTABLE_MEMBER
  delete env.PEERTABLE_POST_TOKEN
  delete env.PEERTABLE_CREDENTIAL_FILE
  const aiterm = new AitermClient({ env })
  const server = spawn(process.execPath, [join(repo, 'room/server.mjs')], {
    env: { ...env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: join(root, 'data'), PEERTABLE_POST_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOutput = ''
  server.stdout.on('data', chunk => { serverOutput += chunk })
  server.stderr.on('data', chunk => { serverOutput += chunk })
  const command = async (...args) => {
    console.error(`実機試験: peertable ${args[0]}`)
    const { stdout } = await execute(process.execPath, [join(repo, 'skill/scripts/cli.mjs'), ...args], {
      env, timeout: 240_000, maxBuffer: 1024 * 1024,
    })
    return JSON.parse(stdout)
  }
  const api = async (path, body) => {
    const response = await fetch(`${base}/api/${room}/${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Peertable-Token': token }, body: JSON.stringify(body),
    })
    assert.ok(response.ok, `${path}: HTTP ${response.status}`)
    return response.json()
  }
  const waitFor = async (label, predicate, timeout = 180_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await predicate()
      if (value) return value
      await sleep(1000)
    }
    throw new Error(`${label}を確認できません`)
  }
  const idle = () => waitFor('公開APIのidle', async () => {
    const observed = await aiterm.observe(sessionId)
    return observed.state === 'idle' && observed.harness_alive === true && observed
  })
  const posted = marker => waitFor(`実harnessの投稿 ${marker}`, async () =>
    (await api('messages')).messages.find(message => message.from === member && message.body === marker))
  let tornDown = false
  let passed = false
  try {
    await waitFor('room起動', () => {
      if (server.exitCode !== null) throw new Error(serverOutput)
      return serverOutput.includes(`on :${port}`)
    }, 15_000)
    assert.equal((await command('setup', project, '--room', room, '--url', base, '--tasks', tasksFile)).status, 'ready')
    const tasks = await readFile(join(project, '.team/tasks.md'), 'utf8')
    assert.equal((await command('setup', project, '--room', room, '--url', base, '--tasks', tasksFile)).status, 'ready')
    assert.equal(await readFile(join(project, '.team/tasks.md'), 'utf8'), tasks)
    const brief = 'roomのpostツールでallへ「[public-live] ready」と完全一致で投稿してください。その後はターンを終了してください。'
    const launched = await command('launch', project, member, '--roles', '実装', '--harness', harness, '--model', model, '--effort', effort, '--brief', brief)
    assert.equal(launched.status, 'ready')
    assert.equal(launched.turn_started, true)
    await posted('[public-live] ready')
    const initial = await idle()
    if (stopProbe) {
      // 故障注入だけをOSへ行い、判定は公開観測とroomへの配信結果で確かめる。
      const pid = initial.process_identity.pid
      process.kill(pid, 'SIGSTOP')
      try {
        await waitFor('native停止の公開観測', async () => {
          const observed = await aiterm.observe(sessionId)
          return observed.state === 'blocked' && observed.reason === 'harness_stopped'
        })
        await waitFor('roomへのblocked配信', async () =>
          (await api('members')).members.find(item => item.name === member)?.status === 'blocked')
      } finally { process.kill(pid, 'SIGCONT') }
      await idle()
    }
    await command('change', project, member, '--model', nextModel, '--effort', nextEffort, '--reason', '公開APIの実機試験')
    const configured = (await api('members')).members.find(item => item.name === member)
    assert.equal(configured.model, nextModel)
    assert.equal(configured.effort, nextEffort)
    assert.equal(configured.aiterm_session_id, sessionId)
    const after = await idle()
    assert.deepEqual(after.process_identity, initial.process_identity)
    await api('messages', { from: 'bell', to: member, body: 'roomのpostツールでallへ「[public-live] woke」と完全一致で投稿し、ターンを終了してください。' })
    await posted('[public-live] woke')
    await idle()
    const resumed = await command('resume', project)
    assert.equal(resumed.status, 'ready')
    assert.equal(resumed.verified.probe, 'delivered')
    assert.deepEqual(resumed.relaunched, [])
    assert.equal((await command('teardown', project)).status, 'done')
    tornDown = true
    assert.equal(existsSync(join(project, '.team')), false)
    assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), originalMcp)
    assert.ok((await api('messages')).messages.some(item => item.body === '[public-live] woke'))
    const sessions = await aiterm.sessions(['PEERTABLE_ROOM'])
    assert.equal(sessions.some(item => item.session_id === sessionId || item.environment?.PEERTABLE_ROOM === room), false)
    passed = true
    return { schema: 'peertable.public-lifecycle-smoke.v1', platform: process.platform, harness, model, nextModel,
      checks: ['setup', '再実行の保存', '実着席と投稿', '同一session設定変更', 'DM応答', 'resume配達', '撤収と履歴・元設定保存'], passed }
  } finally {
    try {
      if (!passed) {
        for (const file of ['alarm-bridge.log', 'seat-status-bridge.log', 'wakeup-bridge.log', 'setup-state.json']) {
          if (existsSync(join(project, '.team', file))) await copyFile(join(project, '.team', file), join(root, file))
        }
      }
      if (!tornDown && existsSync(join(project, '.team/setup-state.json'))) await command('teardown', project)
    } finally {
      await aiterm.close()
      if (server.exitCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve))
        server.kill('SIGTERM')
        await exited
      }
      if (passed) await rm(root, { recursive: true })
      else console.error(`試験失敗の記録: ${root}`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [harness, model, nextModel = model, effort = 'high', nextEffort = 'medium'] = process.argv.slice(2)
  console.log(JSON.stringify(await liveSmoke({ harness, model, nextModel, effort, nextEffort })))
}
