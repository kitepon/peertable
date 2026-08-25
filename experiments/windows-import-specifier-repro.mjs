#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsImportSpecifier } from '../skill/scripts/platform/windows/import-specifier.mjs'
import { resolveWindowsLatticeContracts } from '../skill/scripts/platform/windows/resolve-lattice-contracts.mjs'

const root = await mkdtemp(join(tmpdir(), 'peertable windows import '))
try {
  const modulePath = join(root, 'fixture.mjs')
  await writeFile(modulePath, 'export const value = 42\n')
  const specifier = windowsImportSpecifier(modulePath)
  assert.match(specifier, /^file:\/\//u)
  assert.equal((await import(specifier)).value, 42)
  const shim = join(root, 'npm', 'lattice')
  const expected = join(root, 'npm', 'node_modules', '@quolu', 'lattice', 'src', 'todo-contracts.mjs')
  await mkdir(join(root, 'npm', 'node_modules', '@quolu', 'lattice', 'src'), { recursive: true })
  await writeFile(shim, '')
  await writeFile(expected, '')
  assert.equal(resolveWindowsLatticeContracts(shim), expected)
  console.log('windows import specifier repro: 3/3 green')
} finally {
  await rm(root, { recursive: true, force: true })
}
