#!/usr/bin/env node
// 必須面とscenarioの直積を生成する。fixtureのpassedを製品の実機受入へ流用しない。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { runtimeDigest } from '../skill/scripts/runtime-digest.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
export const surfaces = { claude: ['cli'], codex: ['desktop', 'ide', 'cli'], grok: ['cli'], cursor: ['desktop', 'cli'] }
export { scenarios } from './parent-delivery-acceptance-contract.mjs'
import { scenarios } from './parent-delivery-acceptance-contract.mjs'
import { scenarioPlan, validateBoundary } from '../experiments/parent-product-acceptance/scenarios.mjs'

export const adapterObservations = {
  claude: ['実session/tool_use_idとMCP claudecode/toolUseId', 'PostToolUse/Stop asyncRewakeのnative hook_response exit2と後続assistant', 'PID+開始identityのsession1slot'],
  codex: ['実MCP threadIdと実caller binary/store', 'queue受付IDと同期PostToolUse/Stopのdelete:true・同turn返信', 'idle公式queueの新turn起床・他所有queue不変更'],
  cursor: ['実conversation_id/tool_use_idとupdated_input相関', 'additional_contextとnative背景Shell/task PID相関', '背景完了の同会話返信・次slot再武装'],
  grok: ['実sessionId/toolUseIdとdispatch envelope updatedInput相関', 'native run_terminal_command背景task/PID相関', '正確な完了taskの公開出力取得・parent_read最終page・次slot'],
}
export function expectedCases() {
  return ['darwin', 'linux', 'win32'].flatMap(os => Object.entries(surfaces).flatMap(([harness, executionSurfaces]) => executionSurfaces.flatMap(surface => Object.entries(scenarios).map(([scenario, expected]) => ({
    id: `${os}/${harness}/${surface}/${scenario}`, os, harness, surface, scenario, expected, observations: adapterObservations[harness],
  })))))
}
export function testedSourceCommit(records, { repo = root, sourceCommit } = {}) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const tested = sourceCommit ?? records[0]?.source_commit ?? head
  if (!/^[0-9a-f]{40}$/u.test(tested)) throw Object.assign(new Error('検証対象のcommitが不正です'), { code: 'PARENT_ACCEPTANCE_SOURCE_INVALID' })
  // 証拠を保存するcommit自身のSHAは証拠に書けない。検証済みcommitの包含と現在のruntime digestを別々に照合する。
  try { execFileSync('git', ['merge-base', '--is-ancestor', tested, head], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { throw Object.assign(new Error('検証対象のcommitがrelease候補に含まれていません', { cause: error }), { code: 'PARENT_ACCEPTANCE_SOURCE_NOT_INCLUDED' }) }
  // runtime digestが対象としないroom serverや配布設定も、検証後に変わっていないことを照合する。
  const changed = execFileSync('git', ['diff', '--name-only', tested, '--', 'room', 'skill', 'package.json', 'package-lock.json'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(file => file && !file.endsWith('.test.mjs'))
  if (changed.length) throw Object.assign(new Error(`検証後に製品sourceが変わっています: ${changed.join(', ')}`), { code: 'PARENT_ACCEPTANCE_SOURCE_CHANGED' })
  return tested
}
// 各手順の観測を、その手順・run・会話・artifactへ戻して照合する。
export function auditScenarioSteps(evidence, item, session) {
  const invalid = detail => { throw Object.assign(new Error(detail), { code: 'PARENT_ACCEPTANCE_SCENARIO_INVALID' }) }
  const plan = scenarioPlan(item.scenario, { harness: item.harness, pageChars: evidence.page_chars })
  if (!evidence.run_id || !Array.isArray(evidence.trace) || evidence.trace.length !== plan.length || !Array.isArray(evidence.observations)) invalid('手順またはrunの相関がありません')
  const used = new Set()
  for (const [index, expected] of plan.entries()) {
    const actual = evidence.trace[index]
    if (actual.step !== index || actual.action !== expected.action || actual.expectation !== expected.expectation || !Array.isArray(actual.artifacts) || !actual.artifacts.length
      || (actual.related_sessions !== undefined && (!Array.isArray(actual.related_sessions) || actual.related_sessions.some(value => typeof value !== 'string' || !value)))) invalid('手順の期待値・順序・artifactが一致しません')
    const rows = evidence.observations.filter(row => actual.artifacts.includes(row.artifact))
    if (rows.length !== actual.artifacts.length || new Set(actual.artifacts).size !== actual.artifacts.length || rows.some(row => row.kind !== expected.expectation || used.has(row.artifact))) invalid('手順の実観測が欠けているか再使用されています')
    validateBoundary({ expectation: expected.expectation, verified: true, observations: rows, related_sessions: actual.related_sessions }, { expectation: expected.expectation, session, runId: evidence.run_id, scenario: item.scenario })
    for (const related of actual.related_sessions ?? []) if (!rows.some(row => row.parent_session === related)) invalid('観測のない別会話です')
    for (const row of rows) used.add(row.artifact)
  }
  if (used.size !== evidence.observations.length) invalid('手順に属さない観測があります')
}
export function auditAcceptance(records, { sourceCommit, sourceDigest, packageVersion, readEvidence = file => JSON.parse(readFileSync(resolve(root, file), 'utf8')) } = {}) {
  const byId = new Map(), errors = []
  for (const record of records) { if (byId.has(record.id)) errors.push({ id: record.id, code: 'PARENT_ACCEPTANCE_DUPLICATE' }); byId.set(record.id, record) }
  const expected = expectedCases()
  for (const item of expected) {
    const actual = byId.get(item.id)
    if (!actual) { errors.push({ id: item.id, code: 'PARENT_ACCEPTANCE_MISSING' }); continue }
    if (actual.status !== 'passed' || actual.kind !== 'product_live' || actual.native !== true || !actual.harness_version || !/^[0-9a-f]{40}$/u.test(actual.source_commit ?? '') || !/^[0-9a-f]{64}$/u.test(actual.runtime_digest ?? '') || !actual.package_version || !actual.parent_session || !actual.evidence_file || actual.body_equal !== true || actual.owner_input_required !== false || !actual.receipt_evidence || !actual.observations?.length || (sourceCommit && actual.source_commit !== sourceCommit) || (sourceDigest && actual.runtime_digest !== sourceDigest) || (packageVersion && actual.package_version !== packageVersion)) errors.push({ id: item.id, code: 'PARENT_ACCEPTANCE_INVALID' })
    if (actual.kind === 'product_live' && actual.evidence_file) {
      try {
        const evidence = readEvidence(actual.evidence_file)
        if (item.scenario !== 'audience') {
          try { auditScenarioSteps(evidence, item, actual.parent_session) }
          catch (error) { errors.push({ id: item.id, code: 'PARENT_ACCEPTANCE_SCENARIO_INVALID', detail: error.code ?? error.message }) }
        }
        if (evidence.schema !== 'peertable.parent-live-case.v1' || evidence.case_id !== item.id || evidence.native !== true
          || evidence.source_commit !== actual.source_commit || evidence.harness_version !== actual.harness_version || evidence.parent_session !== actual.parent_session
          || evidence.runtime_digest !== actual.runtime_digest || evidence.package_version !== actual.package_version
          || evidence.os !== item.os || evidence.harness !== item.harness || evidence.surface !== item.surface
          || evidence.owner_input_required !== false || !Array.isArray(evidence.observations) || !evidence.observations.length || evidence.observations.some(event => !event.kind || (item.scenario === 'audience' && event.parent_session !== actual.parent_session) || !event.turn_id)
          || !Array.isArray(evidence.receipts) || !evidence.receipts.length || evidence.receipts.some(receipt => !Number.isSafeInteger(receipt.seq) || receipt.seq <= 0 || !receipt.recipient || receipt.route !== 'parent_receiver' || !['delivered', 'failed', 'unknown'].includes(receipt.result) || !Number.isSafeInteger(receipt.receipt_revision) || receipt.receipt_revision <= 0
            || (item.harness === 'codex' && receipt.result === 'delivered' && (!receipt.queued_submission_id || !receipt.accepted_at)))
          || !Array.isArray(evidence.body_checks) || !evidence.body_checks.length
          || evidence.body_checks.some(check => !check.original || !check.received || typeof check.original.body !== 'string'
            || !isDeepStrictEqual(check.original, check.received))) errors.push({ id: item.id, code: 'PARENT_ACCEPTANCE_EVIDENCE_INVALID' })
      } catch (error) { errors.push({ id: item.id, code: 'PARENT_ACCEPTANCE_EVIDENCE_UNAVAILABLE', detail: error.code ?? error.message }) }
    }
    if (item.scenario === 'audience' && !['dm', 'multiple', 'all'].every(audience => actual.audiences?.[audience]?.body_equal === true && actual.audiences[audience].count === 1)) errors.push({ id: item.id, code: 'PARENT_ACCEPTANCE_AUDIENCE_MISSING' })
  }
  for (const id of byId.keys()) if (!expected.some(item => item.id === id)) errors.push({ id, code: 'PARENT_ACCEPTANCE_UNEXPECTED' })
  return { schema: 'peertable.parent-acceptance-audit.v1', status: errors.length ? 'failed' : 'passed', expected: expected.length, errors }
}
export function approvedReleaseDeferral(decision, { packageVersion, sourceDigest }) {
  return decision?.decision === 'release_with_live_acceptance_deferred'
    && decision.package_version === packageVersion && decision.runtime_digest === sourceDigest
    && typeof decision.owner_instruction === 'string' && decision.owner_instruction.length > 0
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, option, decisionFile] = process.argv.slice(2)
  const commit = option === '--release-decision' ? undefined : option
  const manifest = JSON.parse(readFileSync(file, 'utf8')), records = manifest.records
  try {
    const sourceDigest = runtimeDigest(), packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
    const decision = option === '--release-decision' ? JSON.parse(readFileSync(decisionFile, 'utf8')) : null
    if (approvedReleaseDeferral(decision, { packageVersion, sourceDigest })) {
      console.log(JSON.stringify({ schema: 'peertable.parent-acceptance-audit.v1', status: 'deferred_by_owner', package_version: packageVersion, expected: expectedCases().length, records: records.length, owner_instruction: decision.owner_instruction }))
    } else {
      const result = auditAcceptance(records, { sourceCommit: testedSourceCommit(records, { sourceCommit: commit ?? manifest.source_commit }), sourceDigest, packageVersion }); console.log(JSON.stringify(result)); if (result.status !== 'passed') process.exitCode = 1
    }
  } catch (error) { console.log(JSON.stringify({ schema: 'peertable.parent-acceptance-audit.v1', status: 'failed', expected: expectedCases().length, errors: [{ code: error.code ?? 'PARENT_ACCEPTANCE_SOURCE_FAILED', detail: error.message }] })); process.exitCode = 1 }
}
