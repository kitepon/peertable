#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFile(`${root}/${relative}`, 'utf8')

const [plan, charter, member, standalone, parent, skill] = await Promise.all([
  read('docs/current-design.md'),
  read('skill/templates/charter.md'),
  read('skill/templates/member.md'),
  read('skill/templates/member-standalone.md'),
  read('skill/templates/parent.md'),
  read('skill/SKILL.md'),
])

const squash = (text) => text.replace(/\s+/g, '')
const latticeRule = (text) => {
  const normalized = squash(text)
  return normalized.includes('先行工程をreopenせず')
    && normalized.includes('前担当者へ戻さず')
    && normalized.includes('修正工程も追加しない')
}

assert.match(plan, /後続工程で発見した不具合は、現在の担当者が現在の工程を成立させる修正として直す/)
assert.equal(latticeRule(plan), true)
assert.equal(latticeRule(charter), true)
assert.equal(latticeRule(member), true)
assert.equal(latticeRule(parent), true)
assert.equal(latticeRule(skill), true)

assert.equal(squash(standalone).includes('前担当者へ戻さず'), true)
assert.equal(squash(standalone).includes('修正議題を追加しない'), true)

for (const text of [plan, charter, member, standalone, parent, skill]) {
  assert.equal(squash(text).includes('現在の工程を成立させる修正として'), true)
  assert.equal(squash(text).includes('最終試験結果へ'), true)
}

assert.equal(parent.includes('見つけたバグは直さず'), false)

console.log('current owner fix repro: green')
