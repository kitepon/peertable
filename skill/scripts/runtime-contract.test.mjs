import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { latticeTaskAvailable } from './alarm-condition.mjs'
import { boundedRecent, boundedUnread } from '../../room/message-bounds.mjs'

// TUI判定の試験は所有者Aitermへ移し、ここでは公開契約とPeertableの操作結果を検証する。
import './install-skill.test.mjs'
import './project-scaffold.test.mjs'
import './project-runtime.test.mjs'
import './ensure-cursor-room-mcp.test.mjs'
import './leave-seat.test.mjs'
import './launch-seat.test.mjs'
import './change-seat.test.mjs'
import './room-public-session.test.mjs'
import './seat-observer.test.mjs'
import './seat-approval.test.mjs'
import './runtime-launch-command.test.mjs'
import './ensure-project-runtime.test.mjs'
import './teardown.test.mjs'
import './wakeup-delivery.test.mjs'

test('alarm writerは日本語noteをUTF-8 stdinから保存する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-alarm-'))
  const out = join(dir, 'alarm.json')
  try {
    const input = ['script', 'yuna', 't04-integration が ready になったら工程を確認する', 'exit 0'].join('\0')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./alarm-write.mjs', import.meta.url)), out], {
      input: Buffer.from(input, 'utf8'),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const saved = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(saved.note, 't04-integration が ready になったら工程を確認する')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Lattice task alarmはready/activeだけで成立し未出現taskでは発火しない', () => {
  const status = {
    next_ready: [{ plan_key: 'p', task_id: 't04' }],
    active_set: [{ plan_key: 'p', task_id: 't03' }],
  }
  assert.equal(latticeTaskAvailable(status, 't04', 'p'), true)
  assert.equal(latticeTaskAvailable(status, 't03', 'p'), true)
  assert.equal(latticeTaskAvailable(status, 't05', 'p'), false)
  assert.equal(latticeTaskAvailable(status, 't04', 'other'), false)
})

test('Grok席configはClaude/Cursor互換を止めroom以外のproject MCPを無効化する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peertable-grok-seat-'))
  const output = join(dir, 'seat', 'config.toml')
  try {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
      booth: { command: 'node' }, room: { command: 'node' }, extra: { command: 'node' },
    } }))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./grok-seat-config.mjs', import.meta.url)), dir, output], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const config = readFileSync(output, 'utf8')
    assert.match(config, /\[compat\.claude\][\s\S]*mcps = false/u)
    assert.match(config, /\[compat\.cursor\][\s\S]*hooks = false/u)
    assert.match(config, /disabled_mcp_servers = \["booth","extra"\]/u)
    assert.doesNotMatch(config, /"room"/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('room logは20件・UTF-8 12KB以内で古い分を明示省略する', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ seq: index + 1, body: `本文${index + 1}`.repeat(300) }))
  const result = boundedRecent(messages, message => `[${message.seq}] ${message.body}`, 50)
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 12_100)
  assert.ok(result.requested === 20)
  assert.match(result.text, /古い \d+ 件を出力上限のため省略/u)
  assert.match(result.text, /\[30\]/u)
})

test('room未読は返した位置までだけ進み残りを次回へ保つ', () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({ seq: index + 1, body: `未読${index + 1}`.repeat(500) }))
  const first = boundedUnread(messages, () => true, message => `[${message.seq}] ${message.body}`, 4000)
  assert.ok(first.omitted > 0)
  assert.ok(first.consumedSeq < 6)
  assert.match(first.text, /read_unreadを再実行/u)
})

test('親post入口は明示envだけでなく共通token解決を使う', () => {
  const source = readFileSync(new URL('./post-message.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes("import { resolvePostToken } from './seat-usage.mjs'"))
  assert.ok(source.includes('resolvePostToken(process.env)'))
})
