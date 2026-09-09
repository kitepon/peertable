#!/usr/bin/env node
// 3bridgeを順に起動・更新し、実際のready記録まで確認する。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { AitermClient } from './aiterm-client.mjs'
import { bridgeRecordLive } from './bridge-record-live.mjs'
import { packageRoot } from './install-skill.mjs'
import { projectPath, readSetup, readJson, runScript, fail } from './project-scaffold.mjs'
import { runtimeLaunchCommand } from './runtime-launch-command.mjs'

export const bridgeKinds = Object.freeze(['alarm', 'seat-status', 'wakeup'])
export const bridgeSession = (project, room, kind) => `peertable-${kind}-${room}-${createHash('sha256').update(project).digest('hex').slice(0, 8)}`

export async function ensureBridge(projectArg, kind, { root = packageRoot, env = process.env, aiterm, args = [], force = false } = {}) {
  if (!bridgeKinds.includes(kind)) fail('ENSURE_BRIDGE_KIND_INVALID', kind)
  const project = projectPath(projectArg)
  const state = readSetup(project)
  const team = join(project, '.team')
  const recordPath = join(team, `${kind}-bridge.json`), log = join(team, `${kind}-bridge.log`)
  const script = `${kind}-bridge.mjs`
  const version = readJson(join(root, 'package.json')).version
  const digest = runScript('runtime-digest.mjs', [], { root })
  const previous = existsSync(recordPath) ? readJson(recordPath) : null
  if (bridgeRecordLive(previous) && previous.peertable_version === version && previous.peertable_runtime_digest === digest)
    return { kind, status: 'current', session_id: previous.aiterm_session_id ?? null }
  const ownClient = !aiterm
  aiterm ??= new AitermClient({ env })
  try {
    if (previous && bridgeRecordLive(previous)) runScript(script, [project, '--stop'], { root, env })
    const session = previous?.aiterm_session_id ?? (previous ? `peertable-${kind}-${state.room}` : bridgeSession(project, state.room, kind))
    await aiterm.structured('pty_close', { session_id: session }, 'aiterm.pty-close-result.v1')
    if (existsSync(recordPath)) unlinkSync(recordPath)
    writeFileSync(log, '')
    const launchEnv = { ...env }
    if (launchEnv.PEERTABLE_POST_TOKEN && !launchEnv.PEERTABLE_CREDENTIAL_FILE) {
      const credentials = join(team, 'credentials')
      mkdirSync(credentials, { recursive: true, mode: 0o700 })
      launchEnv.PEERTABLE_CREDENTIAL_FILE = join(credentials, 'bridge.token')
      writeFileSync(launchEnv.PEERTABLE_CREDENTIAL_FILE, `${launchEnv.PEERTABLE_POST_TOKEN}\n`, { mode: 0o600 })
    }
    if (!launchEnv.PEERTABLE_CREDENTIAL_FILE) {
      launchEnv.PEERTABLE_CREDENTIAL_FILE = runScript('seat-credential.mjs', ['prepare', project, state.room, 'runtime'], { env: launchEnv })
    }
    const effectiveArgs = args.length ? args : previous?.args ?? []
    await aiterm.call('pty_open', { name: session })
    await aiterm.structured('pty_send', { session_id: session, text: runtimeLaunchCommand({
      executable: process.execPath, script: join(root, 'skill', 'scripts', script), project,
      args: effectiveArgs, log, env: launchEnv,
    }) }, 'aiterm.pty-send-result.v1')
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const record = existsSync(recordPath) ? readJson(recordPath) : null
      if (record?.ready_at && bridgeRecordLive(record)) {
        const temporary = `${recordPath}.${process.pid}.tmp`
        writeFileSync(temporary, `${JSON.stringify({ ...record, peertable_version: version, peertable_runtime_digest: digest,
          args: effectiveArgs, aiterm_session_id: session })}\n`)
        renameSync(temporary, recordPath)
        return { kind, status: previous ? 'updated' : 'started', session_id: session }
      }
      await delay(200)
    }
    fail('PEERTABLE_RUNTIME_NOT_READY', `${kind}のready記録を確認できません。${log}`)
  } finally {
    if (ownClient) await aiterm.close()
  }
}

export async function ensureProjectRuntime(project, options = {}) {
  const aiterm = options.aiterm ?? new AitermClient({ env: options.env })
  try {
    const bridges = []
    for (const kind of bridgeKinds) bridges.push(await ensureBridge(project, kind, { ...options, aiterm }))
    return { schema: 'peertable.runtime-result.v1', status: 'ready', bridges }
  } finally {
    if (!options.aiterm) await aiterm.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await ensureProjectRuntime(process.argv[2], { force: process.argv.includes('--force') }))) }
  catch (error) { console.error(`${error.code ?? 'PEERTABLE_RUNTIME_FAILED'}: ${error.message}`); process.exitCode = 1 }
}
