#!/usr/bin/env node
// 罠: HTTPのBuffer断片を個別に文字列化すると、分割されたUTF-8が保存前にU+FFFDへ変わる。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'peertable-http-utf8-'))
const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const token = 'utf8-fixture-token', room = 'utf8-fixture'
const server = spawn(process.execPath, [fileURLToPath(new URL('../room/server.mjs', import.meta.url))], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: root, PEERTABLE_POST_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'],
})
let stderr = ''; server.stderr.on('data', data => { stderr += data })
const base = `http://127.0.0.1:${port}/api/${room}`
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${base}/messages`)).ok } catch {}
    if (ready) break
    if (server.exitCode !== null) throw new Error(stderr)
    await delay(25)
  }
  assert.ok(ready, `roomが起動しません: ${stderr}`)
  const prefix = 'あ'.repeat(24130) + '用😀', suffix = '\n"原文末尾" PEERTABLE_UTF8_END😀'
  const body = prefix + 'い'.repeat(40097 - prefix.length - suffix.length) + suffix
  const encoded = Buffer.from(JSON.stringify({ from: 'probe', to: 'all', body }))
  const japanese = encoded.indexOf(Buffer.from('用')), emoji = encoded.indexOf(Buffer.from('😀'))
  const boundaries = [0, japanese + 1, japanese + 2, emoji + 1, emoji + 2, emoji + 3, encoded.length]
  const posted = await new Promise((resolve, reject) => {
    const req = request(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token, 'Content-Length': encoded.length } }, res => {
      res.setEncoding('utf8'); let data = ''
      res.on('data', chunk => { data += chunk }); res.on('error', reject)
      res.on('end', () => { try { assert.equal(res.statusCode, 200, data); resolve(JSON.parse(data)) } catch (error) { reject(error) } })
    })
    req.on('error', reject)
    // 各writeを別HTTP data eventへ渡し、日本語とemojiの途中で境界を固定する。
    ;(async () => {
      for (let i = 1; i < boundaries.length; i++) { req.write(encoded.subarray(boundaries[i - 1], boundaries[i])); await delay(50) }
      req.end()
    })().catch(reject)
  })
  assert.ok(posted.body === body, 'POST応答の原文がUTF-8断片境界で変化しました')
  const response = await (await fetch(`${base}/messages`)).json()
  assert.ok(response.messages.find(message => message.seq === posted.seq).body === body, 'GET messagesの原文が変化しました')
  const saved = readFileSync(join(root, room, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(saved.find(message => message.seq === posted.seq).body === body, '保存logの原文が変化しました')
  console.log(JSON.stringify({ schema: 'peertable.http-utf8-repro.v1', passed: true, original_characters: body.length, split_boundaries: boundaries.length - 2, checks: ['post', 'messages', 'log'] }))
} finally {
  if (server.exitCode === null) { const closed = once(server, 'close'); server.kill('SIGTERM'); await closed }
  rmSync(root, { recursive: true, force: true })
}
