// 製品sourceと試験controllerのcommitを別々に記録し、実行fileをGitの実物へ照合する。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export function runnerProvenance(directory, commit) {
  const fail = detail => { throw Object.assign(new Error(detail), { code: 'ACCEPTANCE_RUNNER_PROVENANCE_MISMATCH' }) }
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) fail('試験controllerの40桁commitが必要です')
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const files = readdirSync(directory).filter(name => name === 'README.md' || name.endsWith('.mjs') && !name.endsWith('.test.mjs')).sort()
  const modules_sha256 = Object.fromEntries(files.map(name => {
    const actual = readFileSync(join(directory, name))
    let committed
    try { committed = execFileSync('git', ['show', `${commit}:experiments/parent-product-acceptance/${name}`], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { fail(`${name}のGit blobを指定したcontroller commitから取得できません`) }
    if (!actual.equals(committed)) fail(`${name}は指定したcontroller commitと一致しません`)
    return [name, sha(actual)]
  }))
  return { commit, modules_sha256, product_source_is_separate: true }
}
