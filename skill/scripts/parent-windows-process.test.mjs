import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { startedFromFileTime, windowsProcessState, sameWindowsProcess } from './parent-windows-process.mjs'
import { processIdentity, sameProcess } from './parent-platform.mjs'

const creation = 134039731428649472n
function native(overrides = {}) {
  const calls = []
  return { calls, open: (...args) => { calls.push(['open', ...args]); return 42 },
    times: (handle, output) => { calls.push(['times', handle]); output.writeBigUInt64LE(creation); return 1 },
    wait: (handle, milliseconds) => { calls.push(['wait', handle, milliseconds]); return 258 },
    close: handle => { calls.push(['close', handle]); return 1 }, error: () => 5, ...overrides }
}

test('FILETIMEを永続CIMの1µs・7桁UTCへ変換し、100nsとmsへ丸めない', () => {
  assert.equal(startedFromFileTime(creation), '2025-10-03T13:52:22.8649470Z')
  assert.equal(startedFromFileTime(116444735999999999n), '1969-12-31T23:59:59.9999990Z')
  assert.equal(startedFromFileTime(116444736000000000n), '1970-01-01T00:00:00.0000000Z')
})

test('同じhandleの開始時刻と存命を照合し、別startedと終了をfalseにする', () => {
  const api = native(), owner = { pid: 123, started: startedFromFileTime(creation) }
  assert.equal(sameWindowsProcess(owner, api), true)
  assert.deepEqual(api.calls, [['open', 0x101000, 0, 123], ['times', 42], ['wait', 42, 0], ['close', 42]])
  assert.equal(sameWindowsProcess({ ...owner, started: '2025-10-03T13:52:22.8649460Z' }, native()), false)
  assert.deepEqual(windowsProcessState(123, native({ wait: () => 0 })), { alive: false })
  assert.deepEqual(windowsProcessState(123, native({ open: () => 0, error: () => 87 })), { alive: false })
})

test('拒否とAPI失敗を終了にせず、開いたhandleは失敗時も閉じる', () => {
  assert.throws(() => windowsProcessState(123, native({ open: () => 0 })), { code: 'PARENT_PROCESS_ACCESS_DENIED', win32_error: 5 })
  for (const overrides of [{ times: () => 0 }, { wait: () => 0xffffffff }, { wait: () => 17 }, { close: () => 0 }]) {
    const api = native(overrides)
    assert.throws(() => windowsProcessState(123, api), { code: 'PARENT_PROCESS_API_FAILED' })
    if (overrides.close === undefined) assert.deepEqual(api.calls.at(-1), ['close', 42])
  }
  assert.throws(() => sameWindowsProcess({ pid: -1 }, native()), { code: 'PARENT_PROCESS_ID_INVALID' })
})

test('Windows実childのCIM本人を同じnative handleで確認し、終了後は一致しない', { skip: process.platform !== 'win32' }, async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
  const owner = processIdentity(child.pid)
  assert.equal(sameProcess(owner), true)
  assert.equal(sameProcess({ ...owner, started: owner.started.replace(/\dZ$/u, '1Z') }), false)
  child.stdin.end(); await exited
  assert.equal(sameProcess(owner), false)
})
