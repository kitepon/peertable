#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  findModelsDoc, resolveSeatPlacement, resolveSeatIdentity,
} from '../skill/scripts/resolve-seat-placement.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = await readFile(join(root, 'experiments/fixtures/02_models.md'), 'utf8')
const launch = await readFile(join(root, 'skill/scripts/launch-seat.sh'), 'utf8')

let ok = true
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

check('launch-seat は role 既定 worker を持たない', !launch.includes('role="${7:-worker}"'))
check('launch-seat は --roles を usage に持つ', launch.includes('--roles'))
check('launch-seat は三者上書き経路を持たない', !launch.includes('SEAT_PLACEMENT_OVERRIDE'))
check('launch-seat は 02_models 解決器を呼ぶ', launch.includes('resolve-seat-placement.mjs'))

const placementScriptDir = join(root, 'skill/scripts')
const bundledModels = join(root, 'skill/02_models.snapshot.md')
const defaultDoc = findModelsDoc({ env: {}, exists: () => true, scriptDir: placementScriptDir })
check('隣接dotagentsが存在しても既定は同梱snapshot', defaultDoc === bundledModels, defaultDoc)
const explicitDoc = findModelsDoc({
  env: { PEERTABLE_MODELS_DOC: join(root, 'experiments/fixtures/02_models.md') },
  exists: () => true,
  scriptDir: placementScriptDir,
})
check('PEERTABLE_MODELS_DOCの明示時だけ外部表を使う', explicitDoc === join(root, 'experiments/fixtures/02_models.md'), explicitDoc)
const explicitRootDoc = findModelsDoc({
  env: { DOTAGENTS_ROOT: '/tmp/explicit-dotagents' }, exists: () => true, scriptDir: placementScriptDir,
})
check('DOTAGENTS_ROOTの明示時だけ外部dotagentsを使う', explicitRootDoc === '/tmp/explicit-dotagents/docs/02_models.md', explicitRootDoc)

const empty = resolveSeatIdentity({ roles: '', markdown: fixture })
check('空の roles を拒否する', empty.error === 'SEAT_ROLE_REQUIRED', empty.error)

const worker = resolveSeatIdentity({ roles: 'worker', markdown: fixture })
check('旧 worker を未知役割として拒否する', worker.error === 'SEAT_ROLE_UNKNOWN', worker.error)

const auditor = resolveSeatIdentity({ roles: 'auditor', markdown: fixture })
check('旧 auditor を未知役割として拒否する', auditor.error === 'SEAT_ROLE_UNKNOWN', auditor.error)

const impl = resolveSeatIdentity({ roles: '実装', markdown: fixture })
check('実装は省略時 Terra×high を settings へ書く',
  impl.settings?.harness === 'codex' && impl.settings?.model === 'gpt-5.6-terra' && impl.settings?.effort === 'high'
    && impl.roles?.[0] === '実装',
  JSON.stringify(impl))

const consult = resolveSeatIdentity({ roles: '相談', markdown: fixture })
check('相談の省略は着席不能1位を落として Grok 2位',
  consult.settings?.harness === 'grok' && consult.settings?.model === 'grok-4.6' && consult.settings?.effort === 'medium',
  JSON.stringify(consult))

const parentSeat = resolveSeatIdentity({ roles: '統括', markdown: fixture })
check('統括を席として起こすのは拒否', parentSeat.error === 'SEAT_ROLE_PARENT_ONLY', parentSeat.error)

const parentOk = resolveSeatIdentity({ roles: '統括', markdown: fixture, allowParentRole: true })
check('統括は親フラグ付きなら通る（配置はオーナー）',
  !parentOk.error && parentOk.roles?.[0] === '統括',
  JSON.stringify(parentOk))

const both = resolveSeatIdentity({ roles: '実装,調査', markdown: fixture })
check('実装と調査は複数役割として通る',
  Array.isArray(both.roles) && both.roles.includes('実装') && both.roles.includes('調査')
    && both.settings?.model === 'gpt-5.6-terra',
  JSON.stringify(both))

const conflict = resolveSeatIdentity({ roles: '実装,反証', markdown: fixture })
check('実装と反証の同時は拒否', conflict.error === 'SEAT_ROLE_CONFLICT', conflict.error)

const outside = resolveSeatIdentity({ roles: '実装', model: 'gpt-5.6-sol', effort: 'medium', markdown: fixture })
check('表外でも指定 model は通す',
  outside.settings?.model === 'gpt-5.6-sol' && outside.settings?.effort === 'medium',
  JSON.stringify(outside))

const custom = resolveSeatIdentity({ roles: '実装', model: 'not-in-table-xyz', harness: 'codex', markdown: fixture })
check('台帳に無い model は harness 付きなら通す',
  custom.settings?.model === 'not-in-table-xyz' && custom.settings?.harness === 'codex',
  JSON.stringify(custom))

const first = resolveSeatPlacement('実装', fixture)
check('単役割 helper は1位 Terra のまま', first.model === 'gpt-5.6-terra' && first.rank === 1, JSON.stringify(first))

const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash'
const missing = spawnSync(bash, [join(root, 'skill/scripts/launch-seat.sh')], { encoding: 'utf8' })
check('launch-seat は roles 無しで usage を出して落ちる',
  missing.status !== 0 && /usage:/.test(missing.stderr || missing.stdout || ''), (missing.stderr || missing.stdout || '').trim())

const env = { ...process.env, PEERTABLE_MODELS_DOC: join(root, 'experiments/fixtures/02_models.md') }
const resolveBin = join(root, 'skill/scripts/resolve-seat-placement.mjs')
const bundledEnv = { ...process.env }
delete bundledEnv.PEERTABLE_MODELS_DOC
delete bundledEnv.DOTAGENTS_ROOT
const viaBundled = spawnSync(process.execPath, [resolveBin, '--roles', '実装'], { encoding: 'utf8', env: bundledEnv })
const bundledResult = viaBundled.status === 0 ? JSON.parse(viaBundled.stdout) : null
check('CLI既定は同梱snapshotを使う',
  bundledResult?.settings.model === 'gpt-5.6-terra' && resolve(bundledResult.source) === bundledModels,
  viaBundled.stderr || viaBundled.stdout)

const viaCli = spawnSync(process.execPath, [resolveBin, '--roles', '実装'], { encoding: 'utf8', env })
check('CLI が fixture から 実装 を解決する',
  viaCli.status === 0 && JSON.parse(viaCli.stdout).settings.model === 'gpt-5.6-terra', viaCli.stderr)

const viaEmpty = spawnSync(process.execPath, [resolveBin], { encoding: 'utf8', env })
check('CLI は roles 無しで SEAT_ROLE_REQUIRED',
  viaEmpty.status !== 0 && /SEAT_ROLE_REQUIRED/.test(viaEmpty.stderr), viaEmpty.stderr.trim())

const server = await readFile(join(root, 'room/server.mjs'), 'utf8')
check('server は役割不足の 400 を足していない', !/SEAT_ROLE_REQUIRED/.test(server))
check('チップに roles/model×effort/mission を出す',
  server.includes('Array.isArray(m.roles)') && server.includes('[m.model,m.effort]')
    && server.includes('[rolesText,settingsText,m.mission]'))

const client = await readFile(join(root, 'room/client.mjs'), 'utf8')
check('MCP members は memberLine を返す', client.includes('members.map(memberLine)'))
check('read_unread は名簿を先頭に付ける', client.includes('rosterText'))

console.log(ok ? 'seat placement repro: green' : 'seat placement repro: RED')
process.exit(ok ? 0 : 1)
