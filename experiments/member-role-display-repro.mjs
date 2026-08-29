#!/usr/bin/env node
// 着座メンバー一覧の素性行に roles が出ない退行を止める。
// 役割は launch-seat / client が member 欄へ既に載せている。表示だけが harness / model / effort
// に閉じていると、ホバーと着席ログの読み口が食い違う。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(process.argv[2] ?? new URL('../room/server.mjs', import.meta.url), 'utf8')

assert.match(
  source,
  /const MEMBER_EVENT_FIELDS = \['status', 'busy_since', 'harness', 'model', 'effort', 'roles', 'mission'\]/,
  'roles 変更は閲覧者が気づく欄として SSE に載る',
)
assert.match(
  source,
  /const rolesText=Array\.isArray\(m\.roles\)&&m\.roles\.length\?m\.roles\.join\('・'\):''[\s\S]*const settingsText=\[m\.model,m\.effort\]\.filter\(Boolean\)\.join\('×'\)/,
  '素性行は roles と model / effort を同じチップのmetadataへ畳む',
)

console.log('member role display repro: green')
