#!/usr/bin/env node
// claim巡回番犬（2026-08-25）の focused repro。実被弾（poly卓 #105-#106）の再演を含む。
// 実行: node experiments/patrol-nudge-repro.mjs
import assert from 'node:assert/strict'
import { patrolTargets } from '../skill/scripts/seat-usage.mjs'


const msg = (seq, from, to, body) => ({ seq, from, to, body })
const base = {
  now: 1_000_000,
  lastNag: new Map(),
  nagIntervalMs: 300_000,
}

// 1) 実被弾の再演: 待機宣言(#105)→目覚まし名指しDM(#106)→起床ターンが落としてidle
//    宣言は#106で失効しているので、巡回は起こす
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev'),
    msg(105, 'mio', 'bell', '[待機] Gamma収集の完了待ち'),
    msg(106, 'alarm', 'mio', '[待機解放条件成立] Gamma本番収集プロセス終了'),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle' })
  assert.deepEqual(t, [{ seat: 'mio', task: 'p2-ev' }], '失効した宣言の裏で寝る席を起こす')
}

// 2) 正当な待機: 宣言後に名指しメッセージが無い → 起こさない
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev'),
    msg(105, 'mio', 'bell', '[待機] 収集完了待ち'),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle' })
  assert.deepEqual(t, [], '生きている宣言は起こさない')
}

// 3) to:"all" は宣言を失効させない（親の待機宣言運用と両立）
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev'),
    msg(105, 'mio', 'bell', '[待機] 収集完了待ち'),
    msg(106, 'bell', 'all', '全体連絡'),
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle' })
  assert.deepEqual(t, [], 'to:allでは宣言は失効しない')
}

// 4) busy中の席は起こさない
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev')]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'busy' })
  assert.deepEqual(t, [], 'busyは対象外')
}

// 5) 宣言が一度も無い無宣言idle → 起こす（ターン長に関係なく）
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev')]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle' })
  assert.deepEqual(t, [{ seat: 'mio', task: 'p2-ev' }], '無宣言idleは起こす')
}

// 6) 再吠え間隔: 直近に吠えた席へは間隔内なら吠えない／間隔超過で再吠え
{
  const messages = [msg(103, 'mio', 'all', '[claim] p2-ev')]
  const lastNag = new Map([['mio', base.now - 60_000]])
  assert.deepEqual(patrolTargets({ ...base, lastNag, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle' }), [], '間隔内は再吠えしない')
  const lastNagOld = new Map([['mio', base.now - 600_000]])
  assert.deepEqual(patrolTargets({ ...base, lastNag: lastNagOld, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle' }).length, 1, '間隔超過で再吠えする')
}

// 7) to_names配列の名指しも失効になる
{
  const messages = [
    msg(103, 'mio', 'all', '[claim] p2-ev'),
    msg(105, 'mio', 'bell', '[待機] x'),
    { seq: 106, from: 'koharu', to: null, to_names: ['mio', 'bell'], body: '確認したい' },
  ]
  const t = patrolTargets({ ...base, activeTasks: ['p2-ev'], messages, statusOf: () => 'idle' })
  assert.deepEqual(t, [{ seat: 'mio', task: 'p2-ev' }], 'to_names名指しでも宣言は失効する')
}

console.log('PATROL_NUDGE_REPRO_PASS')
