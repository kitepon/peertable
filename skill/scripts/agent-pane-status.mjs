#!/usr/bin/env node
import { classifyPaneTail, paneStatusTail } from './seat-usage.mjs'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
process.stdout.write(`${classifyPaneTail(paneStatusTail(Buffer.concat(chunks).toString('utf8')))}\n`)
