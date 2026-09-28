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
export const scenarios = {
  audience: 'DM・親を含む複数宛・all各1回、送信者/room/seq/宛先/原文一致',
  busy: '作業を保持して同じ会話へ配送', final_race: '最終応答/終了競合で欠落重複なし', idle: 'オーナー入力なしで同じ会話が再開',
  consecutive: 'seq順の連続配送と2通目以降の待機', no_external_tools: '外部作業toolなしでも受信維持', no_tools: '全tool省略時の維持または明示rearm_pendingと原文保持',
  original: '日本語・改行・引用・長文の全量回収', burst: '回収上限超過の未読保持', source_reconnect: 'HTTP/SSE再接続catch-upで重複欠落なし',
  process_recovery: 'ready継承/sending unknown/submitted再送なし', claim_race: '受信口間claimで1回だけ出力', output_interruption: '削除/claim後中断はunknownと原文保持',
  receipt_retry: '受付後のreceipt失敗はreceiptだけ復旧', session_change: 'clear/終了/別会話/resumeで旧本文誤流入なし', parallel_rooms: '複数room/親会話の所有分離',
  unavailable_hook: '無効/未承認/実行file欠落は原因付き失敗', foreign_ownership: '利用者/Aitermのqueue・hook・承認・順序保持', compatibility_hooks: '互換hookの二重相関なし',
  background_end: 'task cancel/timeout/終了は成功へ丸めない', lease: '有限lease更新とendpoint/cursor/本文保持', binding_deadline: '束縛/probe期限のtyped failure',
  slot_race: '複数hook開始でも1slot', lifecycle: '同版/新版更新・teardownで親processと履歴保持', package: '公開packageから同じ経路が成立',
}
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
        if (evidence.schema !== 'peertable.parent-live-case.v1' || evidence.case_id !== item.id || evidence.native !== true
          || evidence.source_commit !== actual.source_commit || evidence.harness_version !== actual.harness_version || evidence.parent_session !== actual.parent_session
          || evidence.runtime_digest !== actual.runtime_digest || evidence.package_version !== actual.package_version
          || evidence.os !== item.os || evidence.harness !== item.harness || evidence.surface !== item.surface
          || evidence.owner_input_required !== false || !Array.isArray(evidence.observations) || !evidence.observations.length || evidence.observations.some(event => !event.kind || event.parent_session !== actual.parent_session || !event.turn_id)
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, commit] = process.argv.slice(2)
  const records = JSON.parse(readFileSync(file, 'utf8')).records
  const result = auditAcceptance(records, { sourceCommit: commit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDigest: runtimeDigest(), packageVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version }); console.log(JSON.stringify(result)); if (result.status !== 'passed') process.exitCode = 1
}
