#!/usr/bin/env node
// 台帳のargv_digestを、Aitermの公開プロセス観測へ揃える。
// pid / lstart が台帳と違うときは書き換えず終わる（pid 推定も再利用も禁止）。
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { AitermClient } from './aiterm-client.mjs'
import { seatSessionId } from './seat-session.mjs'

export function refreshSeatRecord(raw, observed, recordedAt) {
  if (!Number.isSafeInteger(raw?.pid) || raw.pid < 1) {
    const error = new Error('台帳の member 行に pid が無い')
    error.code = 'SEAT_IDENTITY_NO_PID'
    throw error
  }
  if (observed.pid !== raw.pid) {
    const error = new Error(`live pid ${observed.pid} は台帳の pid ${raw.pid} と違う`)
    error.code = 'SEAT_IDENTITY_PID_CHANGED'
    throw error
  }
  if (observed.started_identity !== raw.started_identity) {
    const error = new Error('pid の lstart が台帳と一致しない')
    error.code = 'SEAT_IDENTITY_LSTART_CHANGED'
    throw error
  }
  return {
    argv_digest: observed.argv_digest,
    name: raw.name,
    pid: raw.pid,
    recorded_at: recordedAt,
    started_identity: raw.started_identity,
  }
}

function utcRecordedAt() {
  return new Date().toISOString()
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  const [project, name] = process.argv.slice(2)
  if (!project || !name) {
    process.stderr.write('usage: refresh-seat-identity.mjs <project> <name>\n')
    process.exit(2)
  }
  let setup
  try {
    setup = JSON.parse(readFileSync(join(resolve(project), '.team', 'setup-state.json'), 'utf8'))
  } catch (error) {
    process.stderr.write(`SEAT_IDENTITY_STATE_UNREADABLE: ${error.message}\n`)
    process.exit(2)
  }
  const api = `${setup.server_url.replace(/\/$/u, '')}/api/${encodeURIComponent(setup.room)}`
  const memberResponse = await fetch(`${api}/members/${encodeURIComponent(name)}`)
  if (!memberResponse.ok) {
    process.stderr.write(`SEAT_IDENTITY_UNREADABLE: 台帳に ${name} が無い（HTTP ${memberResponse.status}）\n`)
    process.exit(2)
  }
  const raw = (await memberResponse.json()).member
  let observed
  const aiterm = new AitermClient()
  try {
    const id = seatSessionId(raw)
    if (!id) throw new Error('Aitermのsession_idが台帳にありません')
    observed = (await aiterm.observe(id)).process_identity
    if (!observed) throw new Error('Aitermでプロセス本人性を確認できません')
  } catch (error) {
    process.stderr.write(`${error.code || 'SEAT_IDENTITY_UNOBSERVABLE'}: ${error.message}\n`)
    process.exit(2)
  } finally { await aiterm.close() }
  let next
  try {
    next = refreshSeatRecord(raw, observed, utcRecordedAt())
  } catch (error) {
    process.stderr.write(`${error.code}: ${error.message}\n`)
    process.exit(2)
  }
  if (next.argv_digest === raw.argv_digest) {
    process.stdout.write(`${JSON.stringify({ outcome: 'unchanged', name, pid: raw.pid, argv_digest: raw.argv_digest })}\n`)
    process.exit(0)
  }
  // 書込は席別 credential 経由（秘密値を argv/env に載せない既存境界を使う）
  const credentialHelper = join(dirname(fileURLToPath(import.meta.url)), 'seat-credential.mjs')
  const run = promisify(execFile)
  const credential = (await run('node', [credentialHelper, 'prepare', resolve(project), setup.room, name],
    { env: { ...process.env, PEERTABLE_POST_TOKEN: undefined } })).stdout.trim()
  const body = JSON.stringify({ name, argv_digest: next.argv_digest, identity_recorded_at: next.recorded_at })
  await run('node', [credentialHelper, 'request', credential, 'POST', `${api}/members`, body],
    { env: { ...process.env, PEERTABLE_POST_TOKEN: undefined } })
  process.stdout.write(`${JSON.stringify({
    outcome: 'updated',
    name,
    pid: next.pid,
    argv_digest: next.argv_digest,
    previous_argv_digest: raw.argv_digest,
  })}\n`)
}
