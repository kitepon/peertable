import test from 'node:test'
import assert from 'node:assert/strict'
import { expectedCases, auditAcceptance, auditScenarioSteps, testedSourceCommit, approvedReleaseDeferral } from './parent-delivery-acceptance.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scenarioPlan } from '../experiments/parent-product-acceptance/scenarios.mjs'
test('オーナーの公開裁定は対象versionとruntimeだけに適用し、正式受入を合格にしない', () => {
  const decision = { decision: 'release_with_live_acceptance_deferred', package_version: '0.8.63', runtime_digest: 'approved', owner_instruction: '一旦それでリリース、インストールして。' }
  assert.equal(approvedReleaseDeferral(decision, { packageVersion: '0.8.63', sourceDigest: 'approved' }), true)
  assert.equal(approvedReleaseDeferral(decision, { packageVersion: '0.8.64', sourceDigest: 'approved' }), false)
  assert.equal(approvedReleaseDeferral(decision, { packageVersion: '0.8.63', sourceDigest: 'changed' }), false)
  assert.equal(approvedReleaseDeferral(null, { packageVersion: '0.8.63', sourceDigest: 'approved' }), false)
  assert.equal(auditAcceptance([]).status, 'failed')
})
test('全12組合せの必須実行面は欠落/skip/fixtureを製品実機passedにしない', () => {
  const expected = expectedCases()
  assert.equal(expected.length, 525)
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
  assert.ok(auditAcceptance([actual], { sourceDigest: '3'.repeat(64), readEvidence: () => evidence }).errors.some(error => error.id === item.id && error.code === 'PARENT_ACCEPTANCE_INVALID'))
})
test('証拠保存commitは検証済みsourceを包含し、別branchのsourceは通さない', t => {
  const repo = mkdtempSync(join(tmpdir(), 'peertable-source-provenance-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet'); git('config', 'user.name', 'Peertable試験'); git('config', 'user.email', 'fixture@example.invalid')
  mkdirSync(join(repo, 'room')); writeFileSync(join(repo, 'room', 'server.mjs'), 'export const value = 1\n'); git('add', 'room/server.mjs'); git('commit', '--quiet', '-m', '検証対象')
  const tested = git('rev-parse', 'HEAD'), branch = git('branch', '--show-current')
  writeFileSync(join(repo, 'evidence.json'), JSON.stringify({ source_commit: tested })); git('add', 'evidence.json'); git('commit', '--quiet', '-m', '実測証拠')
  assert.notEqual(git('rev-parse', 'HEAD'), tested)
  assert.equal(testedSourceCommit([{ source_commit: tested }], { repo }), tested)
  writeFileSync(join(repo, 'room', 'server.mjs'), 'export const value = 2\n'); git('add', 'room/server.mjs'); git('commit', '--quiet', '-m', '製品変更')
  assert.throws(() => testedSourceCommit([{ source_commit: tested }], { repo }), { code: 'PARENT_ACCEPTANCE_SOURCE_CHANGED' })
  git('checkout', '--quiet', '-b', '別試験', tested)
  writeFileSync(join(repo, 'room', 'server.mjs'), 'export const value = 3\n'); git('add', 'room/server.mjs'); git('commit', '--quiet', '-m', '別source')
  const unrelated = git('rev-parse', 'HEAD'); git('checkout', '--quiet', branch)
  assert.throws(() => testedSourceCommit([{ source_commit: unrelated }], { repo }), { code: 'PARENT_ACCEPTANCE_SOURCE_NOT_INCLUDED' })
})

// fixtureはgateの照合だけを試し、実機受入の成績には使わない。
const scenarioEvidence = (item, session = 'session') => {
  const plan = scenarioPlan(item.scenario, { harness: item.harness, pageChars: 100 })
  return { run_id: 'run', page_chars: 100,
    trace: plan.map((step, index) => ({ step: index, action: step.action, expectation: step.expectation, artifacts: [`/fixture/step-${index}.json`] })),
    observations: plan.map((step, index) => ({ kind: step.expectation, run_id: 'run', scenario: item.scenario, parent_session: session, turn_id: 'turn', artifact: `/fixture/step-${index}.json`, source: 'official_hook' })) }
}
test('全harnessの24scenarioは各手順の期待値・順序・観測相関をgateで照合する', () => {
  for (const item of expectedCases().filter(item => item.os === 'darwin' && item.scenario !== 'audience')) assert.doesNotThrow(() => auditScenarioSteps(scenarioEvidence(item), item, 'session'))
  const item = { scenario: 'binding_deadline', harness: 'codex' }
  for (const mutation of [
    evidence => evidence.trace.pop(),
    evidence => evidence.trace.reverse(),
    evidence => { evidence.trace[0].expectation = '別期待値' },
    evidence => { evidence.observations[0].kind = 'native_delivery' },
    evidence => { evidence.observations[0].run_id = '別run' },
    evidence => { evidence.observations[0].scenario = 'busy' },
    evidence => { evidence.observations[0].parent_session = '別会話' },
    evidence => { evidence.trace[1].artifacts = [...evidence.trace[0].artifacts] },
    evidence => evidence.observations.push({ ...evidence.observations[0], artifact: '/fixture/余剰.json' }),
  ]) {
    const evidence = scenarioEvidence(item); mutation(evidence)
    assert.throws(() => auditScenarioSteps(evidence, item, 'session'))
  }
})
test('専用会話は該当stepの宣言とそのstepの実観測が両方ある場合だけ照合する', () => {
  const item = { scenario: 'binding_deadline', harness: 'codex' }, evidence = scenarioEvidence(item)
  evidence.observations[2].parent_session = '専用会話'
  assert.throws(() => auditScenarioSteps(evidence, item, 'session'))
  evidence.trace[2].related_sessions = ['専用会話']
  assert.doesNotThrow(() => auditScenarioSteps(evidence, item, 'session'))
  evidence.trace[1].related_sessions = ['観測なし会話']
  assert.throws(() => auditScenarioSteps(evidence, item, 'session'))
})
test('原文・上限超過の手順は導入物page上限を証拠に持つ', () => {
  const item = { scenario: 'original', harness: 'claude' }, evidence = scenarioEvidence(item)
  delete evidence.page_chars
  assert.throws(() => auditScenarioSteps(evidence, item, 'session'), { code: 'ACCEPTANCE_PAGE_LIMIT_MISSING' })
})
