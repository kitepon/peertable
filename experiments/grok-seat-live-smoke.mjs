#!/usr/bin/env node
// 実Grokの起動・投稿・モデル変更・起床・撤収を公開APIで確認する。
import { liveSmoke } from './public-lifecycle-live-smoke.mjs'
console.log(JSON.stringify(await liveSmoke({ harness: 'grok', model: 'grok-4.6', nextModel: 'grok-4.5', effort: 'high', nextEffort: 'high' })))
