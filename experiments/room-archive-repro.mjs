#!/usr/bin/env node
// 罠: room に解散の概念が無く、公開一覧（/api/rooms・トップページ）が過去卓の残骸で埋まり、
// 公開トップの live 窓が「最後に配達失敗が流れた死卓」を最新活動として選び続けた（2026-08-30 実測、
// 23 room 中 現役1卓・公開feed末尾78件が全部 [配達失敗]）。
// 固定する契約: teardown の POST /archive で公開一覧から外れ、次の setup の member 登録で自動復帰する。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = 'room-archive-repro-token'
const ROOM = 'room-archive-repro'
const root = mkdtempSync(join(tmpdir(), 'peertable-room-archive-'))

async function freePort() {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')
  return port
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (label, condition, detail = '') => {
  checks.push({ label, condition })
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const port = await freePort()
const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: root, PEERTABLE_POST_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const origin = `http://127.0.0.1:${port}`
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
const api = path => `${origin}/api/${ROOM}/${path}`
const roomsList = async () => (await (await fetch(`${origin}/api/rooms`)).json())
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${origin}/api/rooms`)).ok) break } catch {}
    await sleep(50)
  }

  // 卓を立てる（member 登録が room を作る）
  await fetch(api('members'), { method: 'POST', headers, body: JSON.stringify({ name: 'mio' }) })
  let listed = await roomsList()
  check('現役 room は rooms に載る', listed.rooms.includes(ROOM))
  check('現役 room は archived に載らない', !(listed.archived ?? []).includes(ROOM))

  // 解散（teardown 相当）: archive で公開一覧から外れる
  const arch = await fetch(api('archive'), { method: 'POST', headers })
  check('POST /archive が 200', arch.status === 200)
  listed = await roomsList()
  check('archived room は rooms から外れる', !listed.rooms.includes(ROOM))
  check('archived room は archived 欄に載る', (listed.archived ?? []).includes(ROOM))
  const index = await (await fetch(`${origin}/`)).text()
  check('トップページの主一覧から消え、解散卓の欄に入る', index.includes('解散した卓') && !index.split('解散した卓')[0].includes(`/${ROOM}`))
  const page = await fetch(`${origin}/${ROOM}`)
  check('個別ページは archive 後も読める', page.status === 200)
  const msgs = await fetch(api('messages'))
  check('ログ API も archive 後も読める', msgs.status === 200)

  // 認証なしの archive は拒否（読み取り専用の公開面を保つ）
  const deny = await fetch(api('archive'), { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  check('token 無しの archive は 403', deny.status === 403)

  // 次の卓が同じ部屋で立つ → member 登録が archive を自動解除
  await fetch(api('members'), { method: 'POST', headers, body: JSON.stringify({ name: 'yuzu' }) })
  listed = await roomsList()
  check('member 再登録で rooms へ自動復帰', listed.rooms.includes(ROOM))
  check('復帰後は archived から消える', !(listed.archived ?? []).includes(ROOM))
} finally {
  server.kill('SIGTERM')
  rmSync(root, { recursive: true, force: true })
}
const failed = checks.filter(c => !c.condition)
console.log(failed.length === 0 ? 'PASS room-archive-repro' : `FAIL room-archive-repro (${failed.length}/${checks.length})`)
process.exit(failed.length === 0 ? 0 : 1)
