#!/usr/bin/env node
// 旧shell入口からも同じNode接続処理を使う。実会話への束縛はMCPで行う。
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectCommand } from './parent-connect.mjs'
import { setupFor, actorEnvironment } from './parent-runtime.mjs'
export async function prepareParent(args, { connect = connectCommand } = {}) {
  const [projectArg, name = 'bell', model, effort, harness, flag, mission] = args
  const project = resolve(projectArg)
  setupFor(project)
  const connection = await connect(harness ? ['--target', harness] : [])
  if (connection.status === 'failed') throw Object.assign(new Error(JSON.stringify(connection)), { code: 'PARENT_CONNECT_FAILED' })
  const actor_environment = actorEnvironment(project, name)
  return { schema: 'peertable.parent-prepare.v1', state: 'binding_pending', error_code: 'PARENT_JOIN_REQUIRED', connection,
    tool: 'parent_join', arguments: { project, name, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(flag === '--mission' && mission ? { mission } : {}) },
    actor_environment, role_file: existsSync(join(project, '.team', 'roles', 'parent.md')) ? join(project, '.team', 'roles', 'parent.md') : null }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareParent(process.argv.slice(2)))) }
  catch (error) { console.error(JSON.stringify({ error_code: error.code ?? 'PARENT_PREPARE_FAILED', detail: error.message })); process.exitCode = 1 }
}
