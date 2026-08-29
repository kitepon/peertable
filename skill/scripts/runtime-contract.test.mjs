import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { keysForCodexPane } from './codex-dialog.mjs'
import { buildWindowsBridgeLaunch } from './platform/windows/build-bridge-command.mjs'
import { paneStatusTail } from './seat-usage.mjs'
import { classifyGrokPaneTail } from './vendors/grok/pane-status.mjs'
import { latticeTaskAvailable } from './alarm-condition.mjs'

test('Grokの通信失敗はWaiting表示が残ってもbusyにしない', () => {
  const tail = [
    'Connection failed — reqwest error stream: error sending request.',
    'Check your network and try again.',
    'Waiting for response… 29s [stop]',
  ].join('\n')
  assert.equal(classifyGrokPaneTail(tail), 'blocked')
})

test('通信失敗の無いGrok応答待ちはbusy', () => {
  assert.equal(classifyGrokPaneTail('Waiting for response… 12s [stop]'), 'busy')
})

test('状態判定窓は折返しで14行より上へ出た通信失敗を含む', () => {
  const pane = ['Connection failed — reqwest error stream', ...Array(20).fill('wrapped line'), 'Waiting for response…'].join('\n')
  assert.ok(paneStatusTail(pane).includes('Connection failed'))
})

test('Codexのroom許可とcommand許可は固定選択肢だけを通す', () => {
  assert.deepEqual(keysForCodexPane([
    'Allow the room MCP server to run tool "members"?',
    '3. Always allow',
  ].join('\n')), { kind: 'mcp-allow', keys: ['Down', 'Down', 'Enter'] })
  assert.deepEqual(keysForCodexPane([
    'Would you like to run the following command?',
    "2. Yes, and don't ask again for commands that start with Get-Content",
  ].join('\n')), { kind: 'command-approval', keys: ['Down', 'Enter'] })
})

test('Codexの現在busy／idle composerはscrollbackの古い許可文より優先する', () => {
  const stale = [
    'Would you like to run the following command?',
    "2. Yes, and don't ask again for commands that start with rg",
  ]
  assert.equal(keysForCodexPane([...stale, '• Working (8s • esc to interrupt)', '› Ask Codex to do anything', 'gpt-5.6-terra high · ~/work'].join('\n')), null)
  assert.equal(keysForCodexPane([...stale, '› Ask Codex to do anything', 'gpt-5.6-terra high · ~/work'].join('\n')), null)
})

test('着座はAiterm dispatch前に独自prompt連続判定を重ねない', () => {
  const source = readFileSync(new URL('./launch-seat.sh', import.meta.url), 'utf8')
  const activeBranch = source.slice(
    source.indexOf('if [ "$brief_in_composer" != true ]; then'),
    source.indexOf('  else\n  # Codex はヘッダを描いた後も MCP 初期化を続ける。'),
  )
  assert.ok(activeBranch.includes('aiterm-send.mjs'))
  assert.ok(!activeBranch.includes('brief_ready_streak'))
  assert.ok(source.includes('brief_turn_observed'))
  assert.ok(source.includes('agent-pane-status.mjs'))
  assert.ok(source.includes('aiterm-wait --session'))
})

test('wakeup bridgeはpending DMが無くてもCodex既知dialogを巡回する', () => {
  const source = readFileSync(new URL('./wakeup-bridge.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('dialogSweepRunning'))
  assert.ok(source.includes('await passKnownCodexDialog(member)'))
})

test('円卓runtimeは3bridgeを固定順で一括収束する', () => {
  const source = readFileSync(new URL('./ensure-project-runtime.sh', import.meta.url), 'utf8')
  assert.ok(source.includes('for kind in alarm seat-status wakeup'))
})

test('bridge更新は版数だけでなくruntime source digestへ束縛する', () => {
  const digest = spawnSync(process.execPath, [fileURLToPath(new URL('./runtime-digest.mjs', import.meta.url))], { encoding: 'utf8' })
  assert.equal(digest.status, 0, digest.stderr)
  assert.match(digest.stdout, /^[0-9a-f]{64}$/u)
  const source = readFileSync(new URL('./ensure-bridge.sh', import.meta.url), 'utf8')
  assert.ok(source.includes('peertable_runtime_digest'))
})

test('Windows bridgeはUTF-8を明示してログへ書く', () => {
  const launch = buildWindowsBridgeLaunch({ script: 'bridge.mjs', project: 'C:\\work', log: 'C:\\work\\bridge.log' })
  const encodedAt = launch.argv.indexOf('-EncodedCommand')
  const decoded = Buffer.from(launch.argv[encodedAt + 1], 'base64').toString('utf16le')
  assert.ok(decoded.includes('[Console]::OutputEncoding = $utf8'))
  assert.ok(decoded.includes('Out-File'))
  assert.ok(decoded.includes('-Encoding utf8'))
})

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
