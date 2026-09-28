#!/usr/bin/env node
// 背景commandの完了が同じ親会話へ届くかを調べる。製品receiverの代用ではない。
import { mkdir, readFile, writeFile, appendFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [mode, root, id, body] = process.argv.slice(2)
const record = event => appendFile(join(root, 'background-events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
if (mode === 'inject') {
  await mkdir(join(root, 'background-inbox'), { recursive: true })
  await writeFile(join(root, 'background-inbox', `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ id, body }))
  await record({ kind: 'injected', id, body })
} else if (mode === 'wait') {
  await mkdir(join(root, 'background-inbox'), { recursive: true })
  const slot = join(root, 'background-slot')
  try { await mkdir(slot) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error('PROBE_SLOT_BUSY: 生きた待機と二重登録を区別して観測する')
  }
  const waiter = randomUUID()
  await writeFile(join(slot, 'owner.json'), JSON.stringify({ waiter, pid: process.pid }))
  await record({ kind: 'armed', waiter, pid: process.pid })
  const deadline = Date.now() + 120000
  let message
  while (Date.now() < deadline) {
    const files = (await readdir(join(root, 'background-inbox'))).filter(file => file.endsWith('.json')).sort()
    if (files.length) {
      const path = join(root, 'background-inbox', files[0])
      message = JSON.parse(await readFile(path, 'utf8'))
      await rm(path)
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await rm(slot, { recursive: true })
  const result = message ? { outcome: 'message', room: '配送試験', from: 'probe', to: 'bell', seq: message.id, body: message.body, waiter } : { outcome: 'timeout', waiter }
  await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(result)}\n`, error => error ? reject(error) : resolve()))
  await record({ kind: 'output', result })
  if (!message) process.exitCode = 3
} else throw new Error('PROBE_MODE_INVALID: wait / injectを指定してください')
