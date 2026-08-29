#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../room/server.mjs', import.meta.url), 'utf8')

assert.match(source, /function apply\(m,live=false\)/, 'apply must distinguish catch-up from live messages')
assert.match(source, /for\(const m of r\.messages\)if\(apply\(m,false\)\)added\+\+/, 'catch-up must render without animation')
assert.match(source, /if\(!apply\(m,true\)\)return/, 'direct SSE messages must use the live path')
assert.match(source, /if\(live\)\{[\s\S]{0,100}row\.classList\.add\('flow'\)/, 'only live rows receive the animation class')
assert.match(source, /@keyframes message-flow/, 'the live flow animation must be present')
assert.match(source, /prefers-reduced-motion:reduce/, 'reduced-motion users must be able to suppress the animation')

console.log('room live-flow repro: green')
