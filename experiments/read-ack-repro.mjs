#!/usr/bin/env node
// 読了ack（2026-08-25）の focused repro。
// 検証: (1) POST /messages の read_seq 相乗りが member.read_seq へ保存される
//       (2) 単調増加（小さい値で戻らない） (3) 数値でない/0以下は無視される
//       (4) members 応答に read_seq が載る（wakeup-bridge の注入直前照会が読む面）
// 実行: node experiments/read-ack-repro.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'peertable-read-ack-'))
const PORT = 18000 + Math.floor(Math.random() * 1000)
const TOKEN = 'repro-token'
const server = spawn(process.execPath, [join(here, '..', 'room', 'server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(PORT), PEERTABLE_DATA: dataDir, PEERTABLE_POST_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const base = `http://127.0.0.1:${PORT}/api/ack-room`
const headers = { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN }
const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
const memberOf = async name => ((await (await fetch(`${base}/members`)).json()).members ?? []).find(m => m.name === name)

try {
  // server起動待ち（起動失敗は明示エラー）
  let up = false
  for (let i = 0; i < 50 && !up; i++) {
    try { await fetch(`${base}/members`); up = true } catch { await new Promise(r => setTimeout(r, 100)) }
  }
  assert.ok(up, 'server が起動しない')

  assert.equal((await post('members', { name: 'koharu', harness: 'grok' })).status, 200)
  assert.equal((await post('messages', { from: 'mio', to: 'all', body: 'm1' })).status, 200)
  assert.equal((await post('messages', { from: 'mio', to: 'all', body: 'm2' })).status, 200)

  // (1) read_seq 相乗りが保存される
  assert.equal((await post('messages', { from: 'koharu', to: 'bell', body: '[待機]', read_seq: 3 })).status, 200)
  assert.equal((await memberOf('koharu'))?.read_seq, 3, 'read_seq=3 が保存される')

  // (2) 単調増加: 小さい値では戻らない
  await post('messages', { from: 'koharu', to: 'bell', body: 'x', read_seq: 2 })
  assert.equal((await memberOf('koharu'))?.read_seq, 3, '小さい read_seq で巻き戻らない')
  await post('messages', { from: 'koharu', to: 'bell', body: 'y', read_seq: 6 })
  assert.equal((await memberOf('koharu'))?.read_seq, 6, '大きい read_seq へ前進する')

  // (3) 不正値は無視（保存も 400 もせず本文投稿は成立する）
  const bad = await post('messages', { from: 'koharu', to: 'bell', body: 'z', read_seq: 'abc' })
  assert.equal(bad.status, 200)
  assert.equal((await memberOf('koharu'))?.read_seq, 6, '非数値 read_seq は無視される')

  // (4) member 再登録（欄なし）で read_seq が消えない
  assert.equal((await post('members', { name: 'koharu' })).status, 200)
  assert.equal((await memberOf('koharu'))?.read_seq, 6, 'member 再POSTで read_seq が保たれる')

  // (5) members POST 経由の read_seq 偽装は遮断される（反証4）
  await post('members', { name: 'koharu', read_seq: 99 })
  assert.equal((await memberOf('koharu'))?.read_seq, 6, 'members POST で read_seq を偽装できない')

  // (6) 実 client の ack 挙動（反証3の根治確認）: MCP stdio で client.mjs を駆動する。
  //  - 参加直後に post → read_seq を申告しない（cursor の末尾代入は ack に流用されない）
  //  - read_unread 後に post → 実際に返された最終 seq を申告する
  //  - client 再起動直後に post → 未読了分を ack しない（read_seq が末尾へ跳ばない）
  const credFile = join(dataDir, 'cred.token')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(credFile, `${TOKEN}\n`, { mode: 0o600 })
  const clientEnv = {
    ...process.env, PEERTABLE_URL: `http://127.0.0.1:${PORT}`, PEERTABLE_ROOM: 'ack-room',
    PEERTABLE_MEMBER: 'yuzu', PEERTABLE_CREDENTIAL_FILE: credFile,
    PEERTABLE_ROLES: '実装', PEERTABLE_HARNESS: 'codex',
  }
  const startClient = async () => {
    const proc = spawn(process.execPath, [join(here, '..', 'room', 'client.mjs')], { env: clientEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', d => { out += d })
    let nextId = 10
    const send = m => proc.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'repro', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    for (let i = 0; i < 100 && !out.includes('"id":1'); i++) await new Promise(r => setTimeout(r, 100))
    assert.ok(out.includes('"id":1'), `client 初期化応答なし: ${out.slice(0, 300)}`)
    // 参加登録（cursor 末尾代入）が済むまで member 出現を待つ
    for (let i = 0; i < 100 && !(await memberOf('yuzu')); i++) await new Promise(r => setTimeout(r, 100))
    return {
      call: async (name, args) => {
        const id = nextId++
        send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
        for (let i = 0; i < 100 && !out.includes(`"id":${id}`); i++) await new Promise(r => setTimeout(r, 100))
        assert.ok(out.includes(`"id":${id}`), `tools/call(${name}) 応答なし: ${out.slice(-400)}`)
      },
      kill: () => proc.kill('SIGTERM'),
    }
  }

  // 参加直後（read_unread 無し）に post → read_seq 申告なし
  const c1 = await startClient()
  await c1.call('post', { to: 'bell', message: 'first-post-no-read' })
  assert.equal((await memberOf('yuzu'))?.read_seq ?? 0, 0, '参加直後の post は read_seq を申告しない')

  // client 起動後に新着 → read_unread → post → 実読了 seq を申告
  await post('messages', { from: 'mio', to: 'all', body: 'for-yuzu-1' })
  const seqNow = (await (await fetch(`${base}/messages?since=0`)).json()).messages.at(-1).seq
  await c1.call('read_unread', {})
  await c1.call('post', { to: 'bell', message: 'after-read' })
  assert.equal((await memberOf('yuzu'))?.read_seq, seqNow, 'read_unread 後の post は実読了 seq を申告する')
  c1.kill()

  // client 再起動直後（未読あり・read_unread 無し）に post → ack が末尾へ跳ばない（反証3の根治）
  await post('messages', { from: 'mio', to: 'all', body: 'for-yuzu-2' })
  const c2 = await startClient()
  await c2.call('post', { to: 'bell', message: 'restart-post' })
  assert.equal((await memberOf('yuzu'))?.read_seq, seqNow, '再起動直後の post は未読了分を ack しない')
  c2.kill()

  console.log('READ_ACK_REPRO_PASS')
} finally {
  server.kill('SIGTERM')
  rmSync(dataDir, { recursive: true, force: true })
}
