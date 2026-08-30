import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { markdownLinkTargets, relativeMarkdownTarget } from './markdown-link-targets.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      if (relative === '.git' || relative === '.lattice' || relative === 'node_modules'
        || relative === 'docs/archive' || relative === 'evidence') return []
      return walk(path.join(directory, entry.name), relative)
    }
    return [relative]
  })
}

function markdownLinks(file) {
  return markdownLinkTargets(readFileSync(path.join(root, file), 'utf8'))
}

test('CommonMark/GFM ASTがnested link・reference・HTMLの実targetを列挙する', () => {
  const markdown = [
    '[![inner](images/hero(one).png)](docs/outer(target).md)',
    '',
    '![hero][asset]',
    '',
    '[asset]:',
    '  images/reference.png',
    '',
    '<a href="docs/a&amp;b.md"><img src="images/base.png"',
    '  srcset="images/small.png 1x, images/large.png 2x"></a>',
    '<template><img src="images/template.png"></template>',
  ].join('\n')

  assert.deepEqual(markdownLinkTargets(markdown), [
    { line: 1, target: 'docs/outer(target).md' },
    { line: 1, target: 'images/hero(one).png' },
    { line: 3, target: 'images/reference.png' },
    { line: 8, target: 'docs/a&b.md' },
    { line: 8, target: 'images/base.png' },
    { line: 9, target: 'images/small.png' },
    { line: 9, target: 'images/large.png' },
    { line: 10, target: 'images/template.png' },
  ])
})

test('code・comment・偽HTML属性をlinkとして誤認しない', () => {
  const markdown = [
    '`[inline](missing-inline.md)`',
    '',
    '    ![indented][asset]',
    '',
    '```md',
    '[fenced](missing-fenced.md)',
    '```',
    '<!-- <img src="missing-comment.png"> -->',
    '<div title=\'href="missing-title.md"\' data-src="missing-data.png"></div>',
    '',
    '[asset]: missing-unused.png',
  ].join('\n')

  assert.deepEqual(markdownLinkTargets(markdown), [])
})

test('HTML srcsetの1文字URL・data URI・comma入りpathを落とさない', () => {
  assert.deepEqual(markdownLinkTargets(
    '<img srcset="a 1x, data:image/svg+xml,%3Csvg%3E 2x, images/a,b.png 3x">',
  ), [
    { line: 1, target: 'a' },
    { line: 1, target: 'data:image/svg+xml,%3Csvg%3E' },
    { line: 1, target: 'images/a,b.png' },
  ])
})

test('相対targetをMarkdown位置からpackage内pathへ解決する', () => {
  assert.equal(relativeMarkdownTarget('docs/guide.md', '../images/logo.png?raw=1#hero'), 'images/logo.png')
  assert.equal(relativeMarkdownTarget('README.md', 'docs/'), 'docs')
  assert.equal(relativeMarkdownTarget('README.md', 'https://example.com/file.md'), null)
  assert.equal(relativeMarkdownTarget('README.md', 'data:image/svg+xml,%3Csvg%3E'), null)
  assert.equal(relativeMarkdownTarget('README.md', '#section'), null)
})

test('現行Markdownの相対リンクはrepo内で閉じる', () => {
  const currentMarkdown = walk(root)
    .filter(file => file.endsWith('.md'))
    .filter(file => !file.startsWith('.git/'))
    .filter(file => !file.startsWith('.lattice/'))
    .filter(file => !file.startsWith('docs/archive/'))
    .filter(file => !file.startsWith('evidence/'))
    .filter(file => !file.includes('/node_modules/'))

  const missing = []
  for (const file of currentMarkdown) {
    for (const link of markdownLinks(file)) {
      const target = relativeMarkdownTarget(file, link.target)
      const insideRepository = target !== '..' && !target?.startsWith('../')
      if (target && (!insideRepository || !existsSync(path.join(root, target)))) {
        missing.push(`${file}:${link.line} -> ${target}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('npm配布Markdownの相対リンクはtarball内で閉じる', (t) => {
  if (process.platform === 'win32') {
    t.skip('npm packの実体確認はMarkdown-only Ubuntu jobとPOSIX full jobが担当する')
    return
  }
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--dry-run', '--ignore-scripts', '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  }))[0].files.map(entry => entry.path)
  const packedPaths = new Set(packed)
  const missing = []

  for (const file of packed.filter(entry => entry.endsWith('.md'))) {
    for (const link of markdownLinks(file)) {
      const target = relativeMarkdownTarget(file, link.target)
      const present = target === null || target === '.' || packedPaths.has(target)
        || [...packedPaths].some(entry => entry.startsWith(`${target}/`))
      if (target && !present) {
        missing.push(`${file}:${link.line} -> ${target}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})
