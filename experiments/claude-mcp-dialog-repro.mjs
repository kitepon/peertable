#!/usr/bin/env node
import assert from 'node:assert/strict'
import { keysForClaudeMcpPane } from '../skill/scripts/claude-dialog.mjs'

assert.deepEqual(keysForClaudeMcpPane('New MCP server found in this project: room'), {
  kind: 'single-mcp-consent', keys: ['Down', 'Enter'],
})

const multiple = `2 new MCP servers found in this project
  ❯ [✔] booth
    [✔] room
       Enable selected
 Space to select · Esc to reject all`
assert.deepEqual(keysForClaudeMcpPane(multiple), {
  kind: 'multi-mcp-consent', keys: ['Down', 'Down', 'Enter'],
})

assert.equal(keysForClaudeMcpPane('2 new MCP servers found in this project\n[✔] booth\nEnable selected'), null)
assert.equal(keysForClaudeMcpPane('unknown confirmation'), null)
console.log('claude mcp dialog repro: 4/4 green')
