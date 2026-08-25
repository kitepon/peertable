#!/usr/bin/env node
// claim巡回番犬（観測ベース判定・2026-08-25 オーナー裁定）の focused repro。
// 判定: claim保有 ∧ idle ∧ 「最後のターン終了より後に待機宣言が無い」→ 起こす。
// 実行: node experiments/patrol-nudge-repro.mjs
import assert from 'node:assert/strict'
import { patrolTargets } from '../skill/scripts/seat-usage.mjs'

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
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyEndAt: () => min(20) })
  assert.deepEqual(t, [{ seat: 'mio', task: 'p2-ev' }], 'ターン終了後に宣言なし → 起こす')
}

// 2) 正当な待機: ターン終了(20分)の後に宣言(21分) → 起こさない
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev', 10),
    msg(110, 'mio', 'bell', '[待機] 収集完了待ち', 21),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyEndAt: () => min(20) })
  assert.deepEqual(t, [], 'ターン終了後の宣言 → 正当な待機')
}

// 3) ターン履歴なし（bridge再起動直後）: 宣言が存在すれば起こさない（誤爆しない安全側）
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev', 10),
    msg(105, 'mio', 'bell', '[待機] x', 12),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyEndAt: () => null })
  assert.deepEqual(t, [], '履歴なし＋宣言あり → 起こさない')
}

// 4) 宣言が一度も無い無宣言idle → 履歴が無くても起こす
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev', 10)]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyEndAt: () => null })
  assert.deepEqual(t, [{ seat: 'mio', task: 'p2-ev' }], '無宣言 → 起こす')
}

// 5) busy中の席は起こさない
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev', 10)]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'busy', lastBusyEndAt: () => null })
  assert.deepEqual(t, [], 'busyは対象外')
}

// 6) 再吠え間隔: 間隔内は吠えない／超過で再吠え
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev', 10)]
  const argsBase = { ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyEndAt: () => min(20) }
  assert.deepEqual(patrolTargets({ ...argsBase, lastNag: new Map([['mio', base.now - 60_000]]) }), [], '間隔内は再吠えしない')
  assert.equal(patrolTargets({ ...argsBase, lastNag: new Map([['mio', base.now - 600_000]]) }).length, 1, '間隔超過で再吠えする')
}

// 7) ターン終了直前の宣言（時計ずれ10秒以内）は有効
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev', 10),
    { seq: 110, from: 'mio', to: 'bell', body: '[待機] x', ts: new Date(min(20) - 5_000).toISOString() },
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle', lastBusyEndAt: () => min(20) })
  assert.deepEqual(t, [], 'ターン終了±10秒の宣言は有効（時計ずれ許容）')
}

console.log('PATROL_NUDGE_REPRO_PASS')
