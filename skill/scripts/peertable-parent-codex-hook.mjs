#!/usr/bin/env node
// Codexの同期hook（PostToolUse／Stop）。Peertableの入力だけを作業中のturnへ取り込む。本体はaiterm-steer-delivery。
import { runCodexHookMain } from 'aiterm-steer-delivery'
import { PEERTABLE_PROFILE } from './parent-steer.mjs'
await runCodexHookMain(PEERTABLE_PROFILE, process.argv[2])
