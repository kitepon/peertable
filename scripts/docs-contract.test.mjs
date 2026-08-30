import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

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
  const body = readFileSync(path.join(root, file), 'utf8')
  const links = []
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/gu
  for (const match of body.matchAll(pattern)) {
    const target = match[1].replace(/^<|>$/gu, '')
    links.push({
      line: body.slice(0, match.index).split('\n').length,
      target,
    })
  }
  return links
}

function localTarget(file, target) {
  if (/^(?:https?:|mailto:|#|data:)/u.test(target)) return null
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0]
  if (!withoutFragment) return null
  let decoded = withoutFragment
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    return withoutFragment
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded))
}

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
      const target = localTarget(file, link.target)
      if (target && !existsSync(path.join(root, target))) {
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
      const target = localTarget(file, link.target)
      if (target && !packedPaths.has(target)) {
        missing.push(`${file}:${link.line} -> ${target}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})
