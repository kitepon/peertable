#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  formatWakeNotice,
  isIdleSelfWake,
  isWakeupBridgeTarget,
} from '../skill/scripts/wakeup-delivery.mjs'

assert.equal(
  formatWakeNotice({ seq: 9, from: 'nagi', to: 'all', body: 't1-contract の最終試験を監査へ渡す。\n試験結果: PASS。' }),
  '[Peertable #9] nagi → all: t1-contract の最終試験を監査へ渡す。 / 試験結果: PASS。',
)
assert.equal(
  formatWakeNotice({ seq: 11, from: 'sora', to: 'all', body: '[claim] grok-successor-launch/t2-spawn' }),
  '[Peertable #11] sora → all: [claim] grok-successor-launch/t2-spawn',
)
assert.match(formatWakeNotice({ seq: 2, from: 'nagi', to: 'all', body: '' }), /room.read_log/)
assert.equal(
  formatWakeNotice({ seq: 13, from: 'sora', to: 'nagi', body: '役割逸脱: 作業者は done.sh を打たない' }),
  '[Peertable DM #13] sora → nagi: 役割逸脱: 作業者は done.sh を打たない',
)

assert.equal(isWakeupBridgeTarget({ name: 'nagi', observe: { tmux_target: 'peer-nagi' } }), true)
assert.equal(isWakeupBridgeTarget({ name: 'nagi', vendor: 'codex', observe: null }), true)
assert.equal(isWakeupBridgeTarget({ name: 'bell', delivery: { kind: 'parent_watch', host: 'grok' } }), false)
assert.equal(isWakeupBridgeTarget({ name: 'bell', vendor: 'grok' }, { parentName: 'bell' }), false)
assert.equal(isWakeupBridgeTarget({ name: 'bell', vendor: 'claude' }), false)
assert.equal(isWakeupBridgeTarget({ name: 'bell' }), false)
assert.equal(isWakeupBridgeTarget(undefined), false)

assert.equal(isIdleSelfWake({
  from: 'suzune',
  to: 'suzune',
  body: '[次の行動] 変化なし（active 0）。待機継続。黙って待機を続ける。',
}), true)
assert.equal(isIdleSelfWake({
  from: 'hinata',
  to: 'hinata',
  body: '[次の行動] t04-continuity-dispatch の監査結果を待つ。',
}), false)
assert.equal(isIdleSelfWake({
  from: 'suzune',
  to: 'bell',
  body: '[待機] 実装 ToDo は全て done。',
}), false)
assert.equal(isIdleSelfWake({
  from: 'suzune',
  to: 'all',
  body: '[次の行動] 変化なし。待機継続。',
}), false)

console.log('公開状態による配達判断と本文保持: 成功')
