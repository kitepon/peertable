#!/usr/bin/env node
// Cursorの公式hook。tool結果の印で会話へ結び、次のtool返りへadditional_contextで差し込む。本体はaiterm-steer-delivery。
import { runCursorHookMain } from 'aiterm-steer-delivery'
import { PEERTABLE_PROFILE } from './parent-steer.mjs'
await runCursorHookMain(PEERTABLE_PROFILE)
