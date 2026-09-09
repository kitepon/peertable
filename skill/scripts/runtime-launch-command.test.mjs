import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeLaunchCommand } from './runtime-launch-command.mjs'

test('runtimeのshell輸送はcredential pathだけを渡し秘密値を載せない', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const command = runtimeLaunchCommand({
      executable: 'node', script: '/a b/bridge.mjs', project: "/project's dir", log: '/log.txt', platform,
      env: { PEERTABLE_POST_TOKEN: 'secret-value', PEERTABLE_CREDENTIAL_FILE: '/credential path' },
    })
    assert.ok(!command.includes('secret-value'))
    assert.ok(command.includes('/credential path'))
    assert.ok(!command.includes('tmux') && !command.includes('psmux'))
  }
})

test('実OSのshellで日本語・引用符・置換構文を文字列として渡す', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-runtime-quote-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const project = join(dir, "日本語 owner's project")
  mkdirSync(project)
  const script = join(dir, 'bridge.mjs'), log = join(dir, 'log.txt')
  writeFileSync(script, 'console.log(JSON.stringify({args:process.argv.slice(2),credential:process.env.PEERTABLE_CREDENTIAL_FILE,token:process.env.PEERTABLE_POST_TOKEN??null}))')
  const arg = "引用 ' $(echo unexpected) `echo unexpected`"
  const command = runtimeLaunchCommand({ executable: process.execPath, script, project, log, args: [arg], env: { PEERTABLE_CREDENTIAL_FILE: arg } })
  execFileSync(process.platform === 'win32' ? 'pwsh' : 'bash', process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command], { env: { ...process.env, PEERTABLE_POST_TOKEN: 'not-forwarded' } })
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').replace(/^\uFEFF/u, '').trim()), { args: [project, arg], credential: arg, token: null })
})
