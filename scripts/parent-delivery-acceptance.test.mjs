import test from 'node:test'
import assert from 'node:assert/strict'
import { expectedCases, auditAcceptance } from './parent-delivery-acceptance.mjs'
test('全12組合せの必須実行面は欠落/skip/fixtureを製品実機passedにしない', () => {
  const expected = expectedCases()
  for (const os of ['darwin', 'linux', 'win32']) for (const harness of ['claude', 'codex', 'cursor', 'grok']) assert.ok(expected.some(item => item.os === os && item.harness === harness))
  assert.equal(auditAcceptance([]).errors.length, expected.length)
  assert.equal(auditAcceptance([{ id: expected[0].id, status: 'passed', kind: 'fixture' }]).status, 'failed')
  assert.equal(auditAcceptance([{ id: expected[0].id, status: 'skip' }]).errors[0].code, 'PARENT_ACCEPTANCE_INVALID')
  assert.ok(expected.some(item => item.id === 'linux/codex/desktop/lease'))
})
test('実機passedの宣言だけでは受けず、同source/会話/原文の証拠fileを照合する', () => {
  const item = expectedCases()[0]
  const actual = { ...item, status: 'passed', kind: 'product_live', native: true, harness_version: 'fixture', source_commit: '1'.repeat(40), runtime_digest: '2'.repeat(64), package_version: 'fixture', parent_session: 'session', evidence_file: 'case.json', body_equal: true, owner_input_required: false, receipt_evidence: true, observations: ['native'], audiences: Object.fromEntries(['dm', 'multiple', 'all'].map(key => [key, { body_equal: true, count: 1 }])) }
  const unavailable = auditAcceptance([actual], { readEvidence: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
  assert.ok(unavailable.errors.some(error => error.id === item.id && error.code === 'PARENT_ACCEPTANCE_EVIDENCE_UNAVAILABLE'))
  const original = { room: 'fixture', from: 'mio', to_names: ['bell'], seq: 1, body: '日本語\n引用😀' }
  const evidence = { schema: 'peertable.parent-live-case.v1', case_id: item.id, os: item.os, harness: item.harness, surface: item.surface, native: true, source_commit: actual.source_commit, runtime_digest: actual.runtime_digest, package_version: actual.package_version, harness_version: actual.harness_version, parent_session: actual.parent_session, owner_input_required: false, observations: [{ kind: 'native_hook_response', parent_session: actual.parent_session, turn_id: 'native-turn' }], receipts: [{ seq: 1, recipient: 'bell', route: 'parent_receiver', result: 'delivered', receipt_revision: 1 }], body_checks: [{ original, received: { ...original, body: '欠落' } }] }
  assert.ok(auditAcceptance([actual], { readEvidence: () => evidence }).errors.some(error => error.id === item.id && error.code === 'PARENT_ACCEPTANCE_EVIDENCE_INVALID'))
  evidence.body_checks[0].received = structuredClone(original)
  assert.ok(!auditAcceptance([actual], { readEvidence: () => evidence }).errors.some(error => error.id === item.id))
})
