#!/usr/bin/env node
// Git Bash→Windows native processのargv文字コード変換を通さず、UTF-8 stdinでalarmを保存する。
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
if (!out) throw new Error('ALARM_WRITE_PATH_REQUIRED')

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const fields = Buffer.concat(chunks).toString('utf8').split('\0')
const kind = fields.shift()
let payload
if (kind === 'script' && fields.length === 3 && fields.every(value => value.length > 0)) {
  const [seat, note, script] = fields
  payload = { seat, note, script }
} else if (kind === 'lattice_task_ready' && fields.length === 4
  && fields.slice(0, 3).every(value => value.length > 0)) {
  const [seat, note, task_id, plan_key] = fields
  payload = { seat, note, condition: { type: 'lattice_task_ready', task_id, ...(plan_key ? { plan_key } : {}) } }
} else {
  throw new Error('ALARM_WRITE_PAYLOAD_INVALID')
}
writeFileSync(out, `${JSON.stringify({
  ...payload,
  interval_s: 10,
  created_at: new Date().toISOString(),
})}\n`, { encoding: 'utf8', mode: 0o600 })
