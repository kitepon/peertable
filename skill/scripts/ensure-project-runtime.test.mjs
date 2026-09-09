import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureBridge } from './ensure-project-runtime.mjs'

test('新規runtimeは指定した資格元からファイルを準備して公開PTYへ渡す', async t => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'peertable-runtime-credential-')))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const team = join(project, '.team')
  mkdirSync(team)
  writeFileSync(join(team, 'setup-state.json'), JSON.stringify({ room: 'fixture', server_url: 'http://localhost', mode: 'standalone' }))
  const source = join(project, 'source.env')
  writeFileSync(source, 'PEERTABLE_POST_TOKEN=fixture-credential-123\n', { mode: 0o600 })
  const env = { ...process.env, PEERTABLE_TOKEN_SOURCE_FILE: source }
  delete env.PEERTABLE_POST_TOKEN
  delete env.PEERTABLE_CREDENTIAL_FILE
  let sent = false
  const aiterm = {
    call: async tool => { assert.equal(tool, 'pty_open') },
    structured: async (tool, args) => {
      if (tool === 'pty_close') return {}
      assert.equal(tool, 'pty_send')
      const credentials = join(team, 'credentials')
      const files = readdirSync(credentials)
      assert.equal(files.length, 1)
      assert.equal(readFileSync(join(credentials, files[0]), 'utf8'), 'fixture-credential-123\n')
      assert.ok(args.text.includes(files[0]))
      assert.ok(args.text.includes('PEERTABLE_CREDENTIAL_FILE'))
      assert.ok(!args.text.includes('fixture-credential-123'))
      const stamp = new Date().toISOString()
      writeFileSync(join(team, 'alarm-bridge.json'), JSON.stringify({ pid: process.pid, ready_at: stamp, last_progress_at: stamp }))
      sent = true
      return {}
    },
  }
  assert.equal((await ensureBridge(project, 'alarm', { aiterm, env })).status, 'started')
  assert.equal(sent, true)
})
