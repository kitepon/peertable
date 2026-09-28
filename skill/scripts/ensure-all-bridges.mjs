#!/usr/bin/env node
import { isParentMember } from '../../room/parent-kind.mjs'
// 既存のsetup記録があるprojectだけを巡回する。npm導入からは呼ばない。
import { existsSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AitermClient } from './aiterm-client.mjs'
import { RoomApi } from './room-api.mjs'
import { ensureProjectRuntime } from './ensure-project-runtime.mjs'
import { resumeProject } from './project-runtime.mjs'
import { readSetup } from './project-scaffold.mjs'
import { findSeatSession } from './seat-session.mjs'

const root = resolve(process.argv[2] || join(homedir(), 'Developer'))
const aiterm = new AitermClient()
let failed = false
try {
  const sessions = await aiterm.sessions(['PEERTABLE_MEMBER', 'PEERTABLE_ROOM'])
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const project = join(root, entry.name)
    if (!existsSync(join(project, '.team', 'setup-state.json'))) continue
    try {
      const state = readSetup(project)
      await ensureProjectRuntime(project, { aiterm })
      const members = await new RoomApi(state).members()
      const missing = members.filter(member => !isParentMember(member) && (member.harness ?? member.vendor)
        && !findSeatSession(member, sessions, state.room))
      if (!missing.length) continue
      const lock = join(project, '.team', 'seat-revive.lock')
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 600_000) continue
      writeFileSync(lock, `${new Date().toISOString()}\n`)
      console.error(`席消失を検知: ${project}: ${missing.map(member => member.name).join(', ')}。resumeで再開します`)
      const result = await resumeProject({ project })
      appendFileSync(join(project, '.team', 'seat-revive.log'), `${JSON.stringify(result)}\n`)
    } catch (error) {
      failed = true
      console.error(`PEERTABLE_PATROL_FAILED: ${project}: ${error.message}`)
      appendFileSync(join(project, '.team', 'seat-revive.log'), `${new Date().toISOString()} ${error.message}\n`)
    }
  }
} finally { await aiterm.close() }
if (failed) process.exitCode = 1
