#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
const helper = fileURLToPath(new URL('../skill/scripts/claude-dialog.mjs', import.meta.url))
const cli = spawnSync(process.execPath, [helper, '--keys'], { input: multiple })
assert.equal(cli.status, 0)
assert.equal(cli.stdout.toString('utf8'), 'Down\nDown\nEnter\n')
assert.equal(cli.stdout.includes(13), false)
console.log('claude mcp dialog repro: 7/7 green')
