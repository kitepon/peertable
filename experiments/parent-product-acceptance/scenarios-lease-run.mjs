#!/usr/bin/env node
// lease単独の長時間run。共通導入物/通常認証を使い、短い受入runとはroom/processを分ける。
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createNativeScenarioContext } from './scenarios-native.mjs'
import { runnerProvenance } from './runner-provenance.mjs'
import { runScenario } from './scenarios.mjs'
import { buildCase, buildRecord, selfAudit, acceptCase, project } from './evidence.mjs'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function runLeaseOnly(options) {
  const { pkg, out, harness, sourceCommit, sourceDigest, version, tarballSha256, model } = options
  if (!['claude', 'codex', 'cursor', 'grok'].includes(harness) || !/^[0-9a-f]{40}$/u.test(sourceCommit ?? '') || !/^[0-9a-f]{64}$/u.test(tarballSha256 ?? '')) fail('ACCEPTANCE_LEASE_PROVENANCE_REQUIRED', 'harness/source commit/pack tarballのSHAが必要です')
  const runner = runnerProvenance(dirname(fileURLToPath(import.meta.url)), options.runnerCommit)
  const installedVersion = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
  const { runtimeDigest } = await import(pathToFileURL(join(pkg, 'skill/scripts/runtime-digest.mjs')).href)
  const digest = runtimeDigest()
  if (installedVersion !== version || digest !== sourceDigest) fail('ACCEPTANCE_LEASE_INSTALLED_SOURCE_MISMATCH', '共通導入物のversion/runtime digestがfreezeと一致しません')
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const privateDir = join(out, 'private'); mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  const logFile = join(privateDir, 'lease-progress.jsonl'), summaryFile = join(out, 'summary.json')
  const summary = { schema: 'peertable.lease-run.v1', runner, status: 'running', harness, os: process.platform, source_commit: sourceCommit, runtime_digest: digest, package_version: installedVersion, started_at: new Date().toISOString(), current_boundary: 'prepare', cases: [] }
  const log = (kind, fields = {}) => { const row = { at: new Date().toISOString(), kind, ...fields }; appendFileSync(logFile, JSON.stringify(project(row)) + '\n'); summary.current_boundary = kind; writeFileSync(summaryFile, JSON.stringify(project(summary), null, 2)); process.stdout.write(JSON.stringify(project(row)) + '\n') }
  const port = await new Promise(resolvePort => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const chosen = socket.address().port; socket.close(() => resolvePort(chosen)) }) })
  const token = randomUUID(), tokenFile = join(privateDir, 'room.env'); writeFileSync(tokenFile, `PEERTABLE_POST_TOKEN=${token}\n`, { mode: 0o600 })
  const serverUrl = `http://127.0.0.1:${port}`, room = `parent-lease-${harness}-${randomUUID()}`
  const server = spawn(process.execPath, [join(pkg, 'room/server.mjs')], { cwd: out, env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: join(privateDir, 'room-data'), PEERTABLE_POST_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  const apiFor = name => async (path, body) => { const response = await fetch(`${serverUrl}/api/${encodeURIComponent(name)}/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token }, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) fail('ACCEPTANCE_LEASE_HTTP', `${path}:${response.status}`); return response.json() }
  const sourceMeta = { os: process.platform, harness, surface: 'cli', source_commit: sourceCommit, runtime_digest: digest, package_version: installedVersion, client_version: installedVersion, package_tarball_sha256: tarballSha256, node_version: process.version, runner, room, isolation: { home: 'normal', auth: 'normal', install: '共通npm pack導入物', room: 'lease専用server', fixture: '公式通常CLIの専用project/process' } }
  const errors = []; let context
  try {
    const end = Date.now() + 15000
    while (!(await fetch(`${serverUrl}/api/rooms`).then(response => response.ok, () => false))) { if (server.exitCode !== null || Date.now() >= end) fail('ACCEPTANCE_LEASE_ROOM_START', stderr); await sleep(200) }
    await apiFor(room)('members', { name: 'probe', harness: 'codex' })
    log('prepare', { room, installed_root: pkg })
    context = await createNativeScenarioContext('lease', { pkg, out: privateDir, tokenFile, serverUrl, sourceMeta, apiFor, model })
    log('native_parent_verified', { parent_session: context.session, parent_process: context.caseMeta.parent_process, endpoint_id: context.caseMeta.endpoint_id })
    for (const [name, action] of Object.entries(context.actions)) context.actions[name] = async (input, scope) => { log(`${name}:started`); const result = await action(input, scope); log(`${name}:observed`, { expectation: result.expectation }); return result }
    const measured = await runScenario('lease', context)
    const evidence = buildCase({ meta: context.caseMeta, scenario: 'lease', checks: measured.checks, observations: measured.observations, extra: { trace: measured.trace, page_chars: measured.page_chars, run_id: measured.run_id, boundary_contract: measured.boundaries } })
    const evidenceFile = `rag/parent-delivery/live/${evidence.case_id}.json`, file = join(out, 'public', evidenceFile); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(evidence, null, 2))
    const record = buildRecord(evidence, evidenceFile), audit = selfAudit(record, evidence); acceptCase(record, audit)
    summary.cases.push({ ...record, gate_errors: audit.gate_errors }); writeFileSync(join(out, 'records.json'), JSON.stringify({ records: [record] }, null, 2))
    summary.status = 'passed'; log('lease_completed')
  } catch (error) { errors.push({ code: error.code ?? 'ACCEPTANCE_LEASE_RUN_FAILED', message: error.message, detail: error.detail }); summary.status = 'failed'; log('lease_failed', errors.at(-1)) }
  finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolveExit => server.once('exit', resolveExit)); server.kill('SIGTERM'); await Promise.race([exited, sleep(10000)])
      if (server.exitCode === null && server.signalCode === null) { errors.push({ code: 'ACCEPTANCE_LEASE_ROOM_ALIVE' }); summary.status = 'failed' }
    }
    summary.errors = errors; summary.finished_at = new Date().toISOString(); writeFileSync(summaryFile, JSON.stringify(project(summary), null, 2))
  }
  return summary
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = {}; const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 2) { const flag = args[index], value = args[index + 1]; if (!/^--(?:harness|pkg|out|source-commit|digest|version|tarball-sha256|runner-commit|model)$/u.test(flag) || !value || value.startsWith('--')) fail('ACCEPTANCE_LEASE_ARGUMENT', flag); flags[flag.slice(2)] = value }
  for (const name of ['pkg', 'out']) { if (!flags[name]) fail('ACCEPTANCE_LEASE_ARGUMENT', `--${name}`); flags[name] = resolve(flags[name]) }
  const result = await runLeaseOnly({ ...flags, sourceCommit: flags['source-commit'], sourceDigest: flags.digest, tarballSha256: flags['tarball-sha256'], runnerCommit: flags['runner-commit'] })
  if (result.status !== 'passed') process.exitCode = 1
}
