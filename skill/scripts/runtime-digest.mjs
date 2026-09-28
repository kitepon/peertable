#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function runtimeDigest() {
const root = dirname(fileURLToPath(import.meta.url))
const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if ((entry.name.endsWith('.mjs') || entry.name.endsWith('.sh')) && !entry.name.endsWith('.test.mjs')) files.push(path)
  }
}
walk(root)
for (const name of ['client.mjs', 'parent-client.mjs', 'parent-kind.mjs']) files.push(join(root, '../../room', name))
files.sort((a, b) => relative(root, a).localeCompare(relative(root, b), 'en'))
const hash = createHash('sha256')
for (const file of files) {
  hash.update(relative(root, file).replaceAll('\\', '/'))
  hash.update('\0')
  hash.update(readFileSync(file))
  hash.update('\0')
}
return hash.digest('hex')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(runtimeDigest())
