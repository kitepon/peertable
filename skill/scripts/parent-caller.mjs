// 親endpointの索引と、呼出し元の照合。親の特定そのものはAitermと同じ根拠（parent-steer.mjs）で行う。
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parentHome, atomicJson, readJson, failure } from './parent-platform.mjs'
import { ParentSpool } from './parent-delivery.mjs'
export { clientHarness } from './parent-steer.mjs'

const UUID = /^[0-9a-f-]{36}$/u
export function registerEndpoint(spool) {
  atomicJson(join(parentHome(), 'endpoints', `${spool.id}.json`), { endpoint_id: spool.id, project: realpathSync(spool.project) })
}
export function forgetEndpoint(spool, { home = parentHome() } = {}) {
  const file = join(home, 'endpoints', `${spool.id}.json`)
  if (!existsSync(file)) return
  const index = readJson(file)
  if (index.endpoint_id !== spool.id || realpathSync(index.project) !== realpathSync(spool.project)) throw failure('PARENT_ENDPOINT_INDEX_MISMATCH')
  rmSync(file)
}
export function endpointById(id) {
  if (!UUID.test(id ?? '')) throw failure('PARENT_ENDPOINT_INVALID')
  const file = join(parentHome(), 'endpoints', `${id}.json`)
  if (!existsSync(file)) throw failure('PARENT_ENDPOINT_NOT_FOUND')
  const index = readJson(file)
  return new ParentSpool(index.project, id)
}
export function endpointsFor({ project = null } = {}) {
  const dir = join(parentHome(), 'endpoints')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^[0-9a-f-]{36}\.json$/u.test(name)).map(name => endpointById(name.slice(0, -5)))
    .filter(spool => !project || realpathSync(project) === realpathSync(spool.project))
}
/** 同じharnessの同じ親processからの要求だけを、そのendpointの操作として受け付ける。 */
export function verifyCaller(spool, caller) {
  const binding = spool.read().caller
  if (binding.harness !== caller.harness || binding.owner.pid !== caller.owner.pid || binding.owner.started !== caller.owner.started) throw failure('PARENT_CALLER_MISMATCH')
}
