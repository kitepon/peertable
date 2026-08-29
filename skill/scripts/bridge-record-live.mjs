#!/usr/bin/env node
// 常駐 bridge の record が「この pid のこの process」を指しているかの境界。
// Windows は pid を再利用する。alive な pid だけでは本人ではない
// （2026-08-21 実測: wakeup-bridge.json の pid が oracle-mcp に再利用され、
// 本物の配達は死んだまま ensure-bridge が起動済みと誤認した）。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STALE_MS = 90_000

export function bridgeRecordLive(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false
  const pid = Number(record.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch { return false }
  const stamp = record.last_progress_at || record.progress_at
  if (typeof stamp !== 'string' || stamp.length === 0) return false
  const at = Date.parse(stamp)
  if (!Number.isFinite(at)) return false
  return (now - at) <= STALE_MS
}

export function updateBridgeProgress(path, now = new Date()) {
  const record = JSON.parse(readFileSync(path, 'utf8'))
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...record, last_progress_at: now.toISOString() }) + '\n')
  renameSync(temporary, path)
}

const invokedDirectly = Boolean(process.argv[1])
  && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (invokedDirectly) {
  const path = process.argv[2]
  if (!path) process.exit(2)
  let record
  try { record = JSON.parse(readFileSync(path, 'utf8')) } catch { process.exit(1) }
  process.exit(bridgeRecordLive(record) ? 0 : 1)
}
