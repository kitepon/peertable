#!/usr/bin/env node
// claim巡回番犬（観測ベース判定・2026-08-25 オーナー裁定）の focused repro。
// 判定: claim保有 ∧ idle ∧ 「最後のターン開始より後に待機宣言が無い」→ 起こす。
// 実行: node experiments/patrol-nudge-repro.mjs
import assert from 'node:assert/strict'
import { combineSeatLamp, hasActiveDescendant, patrolTargets } from '../skill/scripts/seat-usage.mjs'

const T0 = Date.parse('2026-08-25T06:00:00.000Z')
const min = n => T0 + n * 60_000
const msg = (seq, from, to, body, atMin) => ({ seq, from, to, body, ts: new Date(min(atMin)).toISOString() })
const base = { now: min(60), lastNag: new Map(), nagIntervalMs: 300_000 }

// 1) 実被弾の再演: 待機宣言(12分)→目覚ましで起床→ターン終了(20分)→宣言なしで就寝
//    宣言がターン終了より古い → 起こす
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev', 10),
    msg(105, 'mio', 'bell', '[待機] 収集完了待ち', 12),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyStartAt: () => min(15) })
  assert.deepEqual(t, [{ seat: 'mio', task: 'p2-ev' }], 'ターン終了後に宣言なし → 起こす')
}

// 2) 正当な待機: ターン終了(20分)の後に宣言(21分) → 起こさない
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev', 10),
    msg(110, 'mio', 'bell', '[待機] 収集完了待ち', 21),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyStartAt: () => min(15) })
  assert.deepEqual(t, [], 'ターン終了後の宣言 → 正当な待機')
}

// 3) ターン履歴なし（bridge再起動直後）: 宣言が存在すれば起こさない（誤爆しない安全側）
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev', 10),
    msg(105, 'mio', 'bell', '[待機] x', 12),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyStartAt: () => null })
  assert.deepEqual(t, [], '履歴なし＋宣言あり → 起こさない')
}

// 4) 宣言が一度も無い無宣言idle → 履歴が無くても起こす
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev', 10)]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyStartAt: () => null })
  assert.deepEqual(t, [{ seat: 'mio', task: 'p2-ev' }], '無宣言 → 起こす')
}

// 5) busy中の席は起こさない
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev', 10)]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'busy', lastBusyStartAt: () => null })
  assert.deepEqual(t, [], 'busyは対象外')
}

// 6) 再吠え間隔: 間隔内は吠えない／超過で再吠え
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev', 10)]
  const argsBase = { ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyStartAt: () => min(15) }
  assert.deepEqual(patrolTargets({ ...argsBase, lastNag: new Map([['mio', base.now - 60_000]]) }), [], '間隔内は再吠えしない')
  assert.equal(patrolTargets({ ...argsBase, lastNag: new Map([['mio', base.now - 600_000]]) }).length, 1, '間隔超過で再吠えする')
}

// 7) ターン中の宣言（開始後・終了前）は有効——実被弾 #120: 終了錨だと正常系が誤爆した
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev', 10),
    msg(110, 'mio', 'bell', '[待機] x', 16),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyStartAt: () => min(15) })
  assert.deepEqual(t, [], 'ターン中に出した宣言は有効（#120の誤爆型）')
}

// 8) hasActiveDescendant: pane子孫のCPU実働検知
{
  const rows = ['  100  1  0.0', '  200  100  0.0', '  300  200  45.2', '  400  1  99.0']
  assert.equal(hasActiveDescendant(rows, 100), true, '孫がCPU消費 → 稼働')
  assert.equal(hasActiveDescendant(rows, 200), true, '直下の子 → 稼働')
  assert.equal(hasActiveDescendant(['  200  100  0.3'], 100), false, '閾値未満 → 非稼働')
  assert.equal(hasActiveDescendant(rows, 999), false, '子孫なし → 非稼働')
}

// ---- combineSeatLamp（ドット1個・席とjobの合成）----
assert.equal(combineSeatLamp('idle', { alive: true, active: true }), 'busy', 'job稼働→点滅')
assert.equal(combineSeatLamp('idle', { alive: true, active: false }), 'idle', 'job生存のみ→点灯')
assert.equal(combineSeatLamp('idle', { alive: false, active: false }), 'idle', 'jobなし席生存→点灯')
assert.equal(combineSeatLamp('busy', { alive: false, active: false }), 'busy', '席ターン中→点滅')
assert.equal(combineSeatLamp('dead', { alive: true, active: false }), 'idle', '席CLI死・job生存→点灯')
assert.equal(combineSeatLamp('dead', { alive: true, active: true }), 'busy', '席CLI死・job稼働→点滅')
assert.equal(combineSeatLamp('dead', { alive: false, active: false }), 'dead', '何も無い→白抜き側')
assert.equal(combineSeatLamp('blocked', { alive: true, active: false }), 'blocked', '承認詰まりは維持')

console.log('PATROL_NUDGE_REPRO_PASS')
