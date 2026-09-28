// WindowsのUTF-8表示も共通の束縛済みmember記録を使う。
import { parentMemberRecord } from '../../parent-runtime.mjs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function parentMember(name, model, effort, harness, mission, endpoint_id) {
  return parentMemberRecord(name, harness, endpoint_id, Object.fromEntries(Object.entries({model, effort, mission}).filter(([, value]) => value)))
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.stdout.write(`${JSON.stringify(parentMember(...process.argv.slice(2)))}\n`) }
  catch (error) { console.error(`${error.code}: ${error.message}`); process.exitCode = 1 }
}
