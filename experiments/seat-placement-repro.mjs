#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  findModelsDoc, resolveSeatIdentity,
} from '../skill/scripts/resolve-seat-placement.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = await readFile(join(root, 'experiments/fixtures/02_models.md'), 'utf8')
const launch = await readFile(join(root, 'skill/scripts/launch-seat.mjs'), 'utf8')
const cli = join(root, 'skill/scripts/cli.mjs')

let ok = true
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

check('launch-seat は role 既定 worker を持たない', !launch.includes('role="${7:-worker}"'))
const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
check('正規CLIは --roles の指定方法を案内する', help.status === 0 && help.stdout.includes('--roles'))
check('launch-seat は三者上書き経路を持たない', !launch.includes('SEAT_PLACEMENT_OVERRIDE'))
check('launch-seat は 02_models 解決器を呼ぶ', launch.includes('resolve-seat-placement.mjs'))
check('正規CLIは --model と --effort を必須として案内する', help.stdout.includes('--roles <roles> --model <model> --effort <effort>'))

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
const explicitRoot = join(tmpdir(), 'explicit-dotagents')
const explicitRootDoc = findModelsDoc({
  env: { DOTAGENTS_ROOT: explicitRoot }, exists: () => true, scriptDir: placementScriptDir,
})
check('DOTAGENTS_ROOTの明示時だけ外部dotagentsを使う', explicitRootDoc === join(explicitRoot, 'docs', '02_models.md'), explicitRootDoc)

const empty = resolveSeatIdentity({ roles: '', markdown: fixture })
check('空の roles を拒否する', empty.error === 'SEAT_ROLE_REQUIRED', empty.error)

const worker = resolveSeatIdentity({ roles: 'worker', markdown: fixture })
check('旧 worker を未知役割として拒否する', worker.error === 'SEAT_ROLE_UNKNOWN', worker.error)

const auditor = resolveSeatIdentity({ roles: 'auditor', markdown: fixture })
check('旧 auditor を未知役割として拒否する', auditor.error === 'SEAT_ROLE_UNKNOWN', auditor.error)

for (const [label, args] of [
  ['役割だけ', {}],
  ['model 無し', { effort: 'high' }],
  ['effort 無し', { model: 'gpt-5.6-terra' }],
]) {
  const roleOnly = resolveSeatIdentity({ roles: '実装', ...args, markdown: fixture })
  check(`${label}の席は SEAT_MODEL_REQUIRED で拒否する`, roleOnly.error === 'SEAT_MODEL_REQUIRED', JSON.stringify(roleOnly))
}

const impl = resolveSeatIdentity({ roles: '実装', model: 'gpt-5.6-terra', effort: 'high', markdown: fixture })
check('指定した model と effort を settings へ書く',
  impl.settings?.harness === 'codex' && impl.settings?.model === 'gpt-5.6-terra' && impl.settings?.effort === 'high'
    && impl.roles?.[0] === '実装',
  JSON.stringify(impl))

const parentSeat = resolveSeatIdentity({ roles: '統括', markdown: fixture })
check('統括を席として起こすのは拒否', parentSeat.error === 'SEAT_ROLE_PARENT_ONLY', parentSeat.error)

const parentOk = resolveSeatIdentity({ roles: '統括', markdown: fixture, allowParentRole: true })
check('統括は親フラグ付きなら通る（配置はオーナー）',
  !parentOk.error && parentOk.roles?.[0] === '統括',
  JSON.stringify(parentOk))

const both = resolveSeatIdentity({ roles: '実装,調査', model: 'gpt-5.6-terra', effort: 'high', markdown: fixture })
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

const custom = resolveSeatIdentity({ roles: '実装', model: 'not-in-table-xyz', effort: 'high', harness: 'codex', markdown: fixture })
check('台帳に無い model は harness 付きなら通す',
  custom.settings?.model === 'not-in-table-xyz' && custom.settings?.harness === 'codex',
  JSON.stringify(custom))

const unresolved = resolveSeatIdentity({ roles: '実装', model: 'not-in-table-xyz', effort: 'high', markdown: fixture })
check('harness を推定できない model は --harness を求める', unresolved.error === 'SEAT_HARNESS_UNRESOLVED', unresolved.error)

const missing = spawnSync(process.execPath, [cli, 'launch', root, 'fixture-missing-role'], { encoding: 'utf8' })
check('正規CLIは roles 無しの着席を拒否する',
  missing.status !== 0 && /SEAT_LAUNCH_ARGS_INVALID/.test(missing.stderr) && /役割/.test(missing.stderr), missing.stderr.trim())

const env = { ...process.env, PEERTABLE_MODELS_DOC: join(root, 'experiments/fixtures/02_models.md') }
const resolveBin = join(root, 'skill/scripts/resolve-seat-placement.mjs')
const bundledEnv = { ...process.env }
delete bundledEnv.PEERTABLE_MODELS_DOC
delete bundledEnv.DOTAGENTS_ROOT
const explicitArgs = ['--roles', '実装', '--model', 'gpt-5.6-terra', '--effort', 'high']
const viaBundled = spawnSync(process.execPath, [resolveBin, ...explicitArgs], { encoding: 'utf8', env: bundledEnv })
const bundledResult = viaBundled.status === 0 ? JSON.parse(viaBundled.stdout) : null
check('CLI既定は同梱snapshotを使う',
  bundledResult?.settings.model === 'gpt-5.6-terra' && resolve(bundledResult.source) === bundledModels,
  viaBundled.stderr || viaBundled.stdout)

const viaCli = spawnSync(process.execPath, [resolveBin, ...explicitArgs], { encoding: 'utf8', env })
check('CLI が fixture の役割名で 実装 を通す',
  viaCli.status === 0 && JSON.parse(viaCli.stdout).settings.model === 'gpt-5.6-terra', viaCli.stderr)

const viaRoleOnly = spawnSync(process.execPath, [resolveBin, '--roles', '実装'], { encoding: 'utf8', env })
check('CLI は役割だけなら SEAT_MODEL_REQUIRED',
  viaRoleOnly.status !== 0 && /SEAT_MODEL_REQUIRED/.test(viaRoleOnly.stderr), viaRoleOnly.stderr.trim())

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
