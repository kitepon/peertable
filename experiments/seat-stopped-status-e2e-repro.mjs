#!/usr/bin/env node
// 実harnessへSIGSTOPを注入し、公開APIとroomまでblockedが届くことを確認する。
// 実行: node experiments/seat-stopped-status-e2e-repro.mjs <harness> <model>
import { liveSmoke } from './public-lifecycle-live-smoke.mjs'
const [harness, model] = process.argv.slice(2)
console.log(JSON.stringify(await liveSmoke({ harness, model, stopProbe: true })))
