#!/usr/bin/env node
import process from 'node:process'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const value = Buffer.concat(chunks).toString('utf8')
process.stdout.write(value.endsWith('\r') ? value.slice(0, -1) : value)
