import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { runnerProvenance } from './runner-provenance.mjs'

test('実行controllerは指定commitの実物に一致し、未commit差分と存在しないblobを拒否する', t => {
  const root = mkdtempSync(join(tmpdir(), 'peertable-controller-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'experiments/parent-product-acceptance'), hooks = join(root, 'empty-hooks')
  mkdirSync(dir, { recursive: true }); mkdirSync(hooks)
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet'); writeFileSync(join(dir, 'controller.mjs'), 'export const label = "実行する内容"\n')
  writeFileSync(join(dir, 'README.md'), '# 試験\n')
  mkdirSync(join(root, 'scripts'))
  for (const file of ['parent-delivery-acceptance.mjs', 'parent-delivery-acceptance-contract.mjs']) writeFileSync(join(root, 'scripts', file), '// 受入契約\n')
  git('add', '--', 'experiments', 'scripts')
  git('-c', `core.hooksPath=${hooks}`, '-c', 'user.name=試験', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'controllerの試験用正本')
  const commit = git('rev-parse', 'HEAD'), proof = runnerProvenance(dir, commit)
  assert.equal(proof.commit, commit); assert.deepEqual(Object.keys(proof.modules_sha256), ['README.md', 'controller.mjs'])
  assert.deepEqual(Object.keys(proof.contract_files_sha256), ['scripts/parent-delivery-acceptance.mjs', 'scripts/parent-delivery-acceptance-contract.mjs'])
  const contract = join(root, 'scripts/parent-delivery-acceptance-contract.mjs')
  writeFileSync(contract, '// 異なる期待値\n')
  assert.throws(() => runnerProvenance(dir, commit), { code: 'ACCEPTANCE_RUNNER_PROVENANCE_MISMATCH' })
  writeFileSync(contract, '// 受入契約\n')
  writeFileSync(join(dir, 'controller.mjs'), 'export const label = "異なる内容"\n')
  assert.throws(() => runnerProvenance(dir, commit), { code: 'ACCEPTANCE_RUNNER_PROVENANCE_MISMATCH' })
  assert.throws(() => runnerProvenance(dir, '0'.repeat(40)), { code: 'ACCEPTANCE_RUNNER_PROVENANCE_MISMATCH' })
})
