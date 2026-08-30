import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const caller = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const reusable = readFileSync(path.join(root, '.github/workflows/product-full-ci.yml'), 'utf8')

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

test('CI実行本体とMarkdown検査を製品repoが所有する', () => {
  assert.match(caller, /uses:\s+\.\/\.github\/workflows\/product-full-ci\.yml/u)
  assert.match(caller, /documentation-command:\s*>-[\s\S]*scripts\/docs-contract\.test\.mjs/u)
  assert.doesNotMatch(caller + reusable, /uses:\s+kitepon\/dotagents\//u)
  assert.match(reusable, /documentation-command:[\s\S]*required:\s+true/u)
  assert.doesNotMatch(reusable, /documentation-command:[\s\S]{0,180}default:\s*["']{2}/u)
  assert.match(reusable, /DOCUMENTATION_COMMAND:\s*\$\{\{ inputs\.documentation-command \}\}/u)
  assert.match(reusable, /if: steps\.changes\.outputs\.product_change == 'false'\n\s+shell: bash\n\s+run: \$\{\{ inputs\.documentation-command \}\}/u)
})

test('外部actionは40桁commit SHAへ固定する', () => {
  const refs = [...(caller + reusable).matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)]
    .map(match => match[1])
    .filter(ref => !ref.startsWith('./'))
  assert.ok(refs.length > 0)
  for (const ref of refs) assert.match(ref, /@[0-9a-f]{40}$/u)
})

test('Windows native CIとruntimeはPowerShell 7だけを使う', () => {
  assert.doesNotMatch(reusable, /Git\\bin\\bash|shell:\s*(?:powershell|cmd)/iu)
  assert.ok((reusable.match(/shell:\s+pwsh/gu) ?? []).length >= 3)

  const runtime = walk(path.join(root, 'skill/scripts'))
    .filter(file => /\.(?:mjs|sh)$/u.test(file))
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
  assert.doesNotMatch(runtime, /['"](?:powershell|cmd)\.exe['"]|process\.env\.ComSpec/iu)
  assert.match(runtime, /pwsh\.exe/u)
})
