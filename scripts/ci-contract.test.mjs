import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const caller = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const reusable = readFileSync(path.join(root, '.github/workflows/product-full-ci.yml'), 'utf8')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const productRunner = readFileSync(path.join(root, 'scripts/run-product-ci.mjs'), 'utf8')

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

test('親配送の故障試験と全entryのsyntax検査を3OS製品CIへ登録する', () => {
  for (const file of ['skill/scripts/parent-delivery.test.mjs', 'skill/scripts/parent-source-runtime.test.mjs', 'room/parent-client.test.mjs', 'scripts/parent-delivery-acceptance.test.mjs', 'experiments/delivery-receipt-repro.mjs', 'experiments/http-utf8-body-repro.mjs']) assert.ok(productRunner.includes(file))
  assert.match(productRunner, /scriptsWithExtension\(path\.join\(root, directory\), '\.mjs'\)/u)
  for (const directory of ['room', 'skill/scripts', 'scripts']) for (const file of walk(path.join(root, directory)).filter(file => file.endsWith('.mjs'))) {
    const source = readFileSync(file, 'utf8')
    if (source.includes('#!')) assert.ok(source.startsWith('#!') || !/^#!/mu.test(source), `${file}のshebangが先頭ではありません`)
  }
})

test('公開前gateは実機受入manifestを検査し、fixture試験だけでpublishしない', () => {
  const prepublish = readFileSync(path.join(root, 'scripts/prepublish.mjs'), 'utf8')
  assert.match(prepublish, /scripts\/parent-delivery-acceptance\.mjs/u)
  assert.match(prepublish, /rag\/parent-delivery\/product-acceptance\.json/u)
  assert.equal(manifest.scripts['verify:parent-delivery'], 'node scripts/parent-delivery-acceptance.mjs rag/parent-delivery/product-acceptance.json')
})

test('CI実行本体とMarkdown検査を製品repoが所有する', () => {
  assert.match(caller, /uses:\s+\.\/\.github\/workflows\/product-full-ci\.yml/u)
  assert.match(caller, /documentation-command:\s*>-[\s\S]*npm ci --ignore-scripts --no-audit --no-fund && npm run test:docs/u)
  assert.doesNotMatch(caller + reusable, /uses:\s+kitepon\/dotagents\//u)
  assert.match(reusable, /documentation-command:[\s\S]*required:\s+true/u)
  assert.doesNotMatch(reusable, /documentation-command:[\s\S]{0,180}default:\s*["']{2}/u)
  assert.match(reusable, /DOCUMENTATION_COMMAND:\s*\$\{\{ inputs\.documentation-command \}\}/u)
  assert.match(reusable, /if: steps\.changes\.outputs\.product_change == 'false'\n\s+shell: bash\n\s+run: \$\{\{ inputs\.documentation-command \}\}/u)
})

test('Markdown parserはCI用devDependencyだけに置く', () => {
  for (const dependency of ['parse-srcset', 'parse5', 'remark-gfm', 'remark-parse', 'unified']) {
    assert.equal(manifest.dependencies?.[dependency], undefined)
    assert.ok(manifest.devDependencies?.[dependency])
  }
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
