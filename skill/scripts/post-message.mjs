#!/usr/bin/env node
// room へ発言を送り、server の受領（seq）を確認してから成功終了する。
// 「JSONを印字しただけで送った気になる」事故（2026-08-26・poly 14時間未達）を根治するため、
// 既定動作は送信。JSON組み立てだけが要る内部script用に --build-only を残す（UTF-8印字が目的。
// python stdout の cp932 は日本語本文を壊す）。
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const buildOnly = args[0] === '--build-only'
if (buildOnly) args.shift()
const [from, to, ...rest] = args
const body = rest.join('\n')
if (!from || !to || body.length === 0) {
  process.stderr.write('usage: post-message.mjs [--build-only] <from> <to> <body>\n送信には PEERTABLE_URL+PEERTABLE_ROOM または cwd の .team/setup-state.json と、PEERTABLE_POST_TOKEN が要る\n')
  process.exit(2)
}
const payload = JSON.stringify({ from, to, body })
if (buildOnly) {
  process.stdout.write(`${payload}\n`)
  process.exit(0)
}

let url = process.env.PEERTABLE_URL ?? null
let room = process.env.PEERTABLE_ROOM ?? null
if (!url || !room) {
  const statePath = resolve('.team/setup-state.json')
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    url = url ?? state.server_url
    room = room ?? state.room
  }
}
if (!url || !room) {
  process.stderr.write('POST_MESSAGE_TARGET_UNRESOLVED: PEERTABLE_URL/PEERTABLE_ROOM も cwd の .team/setup-state.json も無く、送信先を決められない\n')
  process.exit(1)
}
const token = process.env.PEERTABLE_POST_TOKEN ?? null

const headers = { 'content-type': 'application/json' }
if (token !== null) headers['x-peertable-token'] = token
let res, text
try {
  res = await fetch(`${url.replace(/\/$/, '')}/api/${room}/messages`, { method: 'POST', headers, body: payload })
  text = await res.text()
} catch (error) {
  process.stderr.write(`POST_MESSAGE_SEND_FAILED: ${error.message}\n`)
  process.exit(1)
}
let seq = null
try { seq = JSON.parse(text).seq ?? null } catch { /* 応答が JSON でない時は下の受領判定で落ちる */ }
if (!res.ok || !Number.isInteger(seq)) {
  process.stderr.write(`POST_MESSAGE_NOT_ACCEPTED: status=${res.status} body=${text.slice(0, 300)}\n`)
  process.exit(1)
}
process.stdout.write(`${text.trim()}\n`)
