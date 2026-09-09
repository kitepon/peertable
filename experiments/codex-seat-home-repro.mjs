#!/usr/bin/env node
// Codex 席は project .codex を上書きせず、席専用 CODEX_HOME へ room MCP を書く。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const helper = resolve(root, 'skill/scripts/ensure-codex-room-mcp.mjs')
const project = mkdtempSync(join(tmpdir(), 'peertable-codex-project-'))
const hinata = mkdtempSync(join(tmpdir(), 'peertable-codex-hinata-'))
const nagi = mkdtempSync(join(tmpdir(), 'peertable-codex-nagi-'))
try {
  mkdirSync(join(project, '.codex'))
  writeFileSync(join(project, '.codex/config.toml'), 'model = "shared"\n')
  const run = (home, member) => execFileSync(process.execPath, [helper, 'ensure', project, root], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: home,
      PEERTABLE_URL: 'http://127.0.0.1:18860',
      PEERTABLE_ROOM: 'fixture-room',
      PEERTABLE_MEMBER: member,
      PEERTABLE_CREDENTIAL_FILE: '/tmp/fixture-credential',
      PEERTABLE_VENDOR: 'codex',
      PEERTABLE_HARNESS: 'codex',
      PEERTABLE_MODEL: 'gpt-5.6-terra',
      PEERTABLE_ROLE: '実装',
      PEERTABLE_ROLES: '実装',
    },
  })
  run(hinata, 'hinata')
  run(nagi, 'nagi')
  const shared = readFileSync(join(project, '.codex/config.toml'), 'utf8')
  assert.equal(shared, 'model = "shared"\n')
  const hinataCfg = readFileSync(join(hinata, 'config.toml'), 'utf8')
  const nagiCfg = readFileSync(join(nagi, 'config.toml'), 'utf8')
  assert.match(hinataCfg, /PEERTABLE_MEMBER = "hinata"/)
  assert.match(nagiCfg, /PEERTABLE_MEMBER = "nagi"/)
  assert.doesNotMatch(hinataCfg, /PEERTABLE_MEMBER = "nagi"/)
} finally {
  rmSync(project, { recursive: true, force: true })
  rmSync(hinata, { recursive: true, force: true })
  rmSync(nagi, { recursive: true, force: true })
}

console.log('codex seat home repro: green')
